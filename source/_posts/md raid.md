---
title: MD RAID
date: 2026-11-11
tags: [学习笔记, Linux Kernel, 存储栈, RAID]
# Cover artwork by Ya ju: https://wallhaven.cc/w/9m2mo1
thumbnail: /images/covers/md-raid-thumbnail.webp
cover: /images/covers/md-raid.webp
excerpt: Linux MD 软件 RAID 机制。
---

# MD raid

MD raid 又称为软件 raid，中文名称为多设备磁盘阵列。是基于软件实现的对磁盘的逻辑阵列拼接，使其行为符合 raid 实现。

## raid0

raid0 又称为条带化存储，将输入的数据按照块分开，分布式存储在不同磁盘上，具有很高的存储效率。raid0 不对存储数据有任何安全性保证，没有备份恢复功能，因此不适合安全性要求高的存储场景。

### strip_zone

条带区（`strip_zone`）结构体定义在`drivers/md/raid0.h`中：

```c
struct strip_zone {
	sector_t zone_end;	/* 下一个条带区开始的位置（扇区号） */
	sector_t dev_start;	/* 设备上条带的真实位置（扇区号） */
	int	 nb_dev;	/* 参与当前条带区的设备数量 */
	int	 disk_shift;	/* 原始布局之下，当前条带区从哪个设备开始 */
};
```

结构体成员`disk_shift`记录的是块索引，其计算公式为：

$$
\text{disk\_size} = (\text{当前设备起始逻辑扇区} / \text{chunk\_sectors}) \% \text{nb\_dev}
$$

其中，`chunk_sectors`表示在条带化存储中一个连续存储区域的大小，单位为扇区。从公式可以知晓：raid0 的存储逻辑是将设备视为一个环队列，当存满一个设备的扇区，立即按顺序存储到环上的下一个设备的对应区域。

另外，对于一个 raid0 阵列，`strip_zone`不是唯一的，当成员设备`chunk`数量不一致时，存在多个条带区：

- 设备A、B、C 的 chunks 数量分别为 5、5、3；

- `strip_zone_1`由`A_chunks[:3]`、`B_chunks[:3]`、`C_chunks`构成；

- `strip_zone_2`由`A_chunks[3:]`、`B_chunks[3:]`构成。

### r0layout

这是一个枚举体，在`struct strip_zone`同一文件下：

```c
enum r0layout {
	RAID0_ORIG_LAYOUT = 1,
	RAID0_ALT_MULTIZONE_LAYOUT = 2,
};
```

它存在的意义是：在`Linux 3.14`版本中，意外更改了 raid0 成员设备不完全相同的情况，所以有：

- `RAID0_ORIG_LAYOUT`表示原本逻辑：根据整个阵列的全局 chunk 编号布局；

- `RAID0_ALT_MULTIZONE_LAYOUT` 表示使用修改后的逻辑：根据当前`strip_zone`内部的 chunk 编号布局。

比如，设备A、B、C 的 chunks 数量分别为 5、5、3，可以得知第二个`strip_zone`由B、C两个设备构成，起始 chunk 的全局编号为 9：

- 对于`RAID0_ORIG_LAYOUT`版本，我们应该使用 $9 \% 2 = 1$，就是 C 作为起始位置；

- 对于`RAID0_ALT_MULTIZONE_LAYOUT`版本，我们应该使用 0 作为起始位置；

### r0conf

这里是对 raid0 各项参数的集成：

```c
struct r0conf {
	struct strip_zone	*strip_zone;
	struct md_rdev		**devlist; // raid 下的设备，指向 strip_zone->dev
	int			nr_strip_zones;
	enum r0layout		layout;
};
```

- `strip_zone`其实是一个指向数组首元素的指针，方便多`strip_zone`管理；

- `devlist`并不是简单的设备堆砌，而是按照`strip_zone`的顺序，将设备按照`chunk`切割之后的顺序进行排序：

  - 设备A、B、C 的 chunks 数量分别为 2、2、1；

  - 根据后文初始化条带的过程，`dev_list`大小为 `6 * sizeof(struct md_rdev*)`

  - 这样`dev_list`就是：`[A, B, C, A, B, NULL]`；

  - 其中`[A,B,C]`是条带区 1，`[A, B]` 是条带 2。

### 条带区初始化

在函数`create_strip_zones`中，实现了条带的初始化：

```c
static int create_strip_zones(struct mddev *mddev, struct r0conf **private_conf)
{
	int i, c, err;
	sector_t curr_zone_end, sectors;
	struct md_rdev *smallest, *rdev1, *rdev2, *rdev, **dev;
	struct strip_zone *zone;
	int cnt;
	struct r0conf *conf = kzalloc_obj(*conf);
	unsigned int blksize = 512;
    
    // 在不是 device mapper 的情况下
    // 读取 gendisk 的 resuest_quene 的逻辑块大小
    // mddev_is_dm: mddev 下 gendisk 为空就是 dm
	if (!mddev_is_dm(mddev)) 
		blksize = queue_logical_block_size(mddev->gendisk->queue);

	*private_conf = ERR_PTR(-ENOMEM);
	if (!conf)
		return -ENOMEM;
		
    // 设备比较阶段
	rdev_for_each(rdev1, mddev) { // 枚举出一个设备
		pr_debug("md/raid0:%s: looking at %pg\n",
			 mdname(mddev),
			 rdev1->bdev);
		c = 0;

		/* round size to chunk_size */
		sectors = rdev1->sectors; // 一个设备的总扇区数
		// sectors = sectors / chunk_sectors
		// 这里进行了整除，直接去掉无法凑成 chunk_sectors 的残余扇区
		sector_div(sectors, mddev->chunk_sectors);
		// 返回实际可用的扇区数量
		rdev1->sectors = sectors * mddev->chunk_sectors;

        // 如果是 device mapper
        // 同样是寻找块大小
		if (mddev_is_dm(mddev))
			blksize = max(blksize, queue_logical_block_size(
				      rdev1->bdev->bd_disk->queue));

        // 将 rdev1 与其余所有块进行对比
		rdev_for_each(rdev2, mddev) {
			pr_debug("md/raid0:%s:   comparing %pg(%llu)"
				 " with %pg(%llu)\n",
				 mdname(mddev),
				 rdev1->bdev,
				 (unsigned long long)rdev1->sectors,
				 rdev2->bdev,
				 (unsigned long long)rdev2->sectors);
			// 如果两个设备相同，终止对比
			// 这里是为了保证设备遍历不重复(注意自己和自己不会发生比较)
			// (1, 1)
			// (2, 1) (2, 2)
			// (3, 1) (3, 2) (3, 3)
			// (4, 1) (4, 2) (4, 3) (4, 4)
			if (rdev2 == rdev1) { 
				pr_debug("md/raid0:%s:   END\n",
					 mdname(mddev));
				break;
			}
			// 如果两个块的可用扇区数量相同
			// 直接 break 
			// 这里不需要担心与后续块的相同问题
			if (rdev2->sectors == rdev1->sectors) {
				/*
				 * Not unique, don't count it as a new
				 * group
				 */
				pr_debug("md/raid0:%s:   EQUAL\n",
					 mdname(mddev));
				c = 1;
				break;
			}
			pr_debug("md/raid0:%s:   NOT EQUAL\n",
				 mdname(mddev));
		}
		
        // 如果发现两个块的大小不同，直接增加条带数量
		if (!c) {
			pr_debug("md/raid0:%s:   ==> UNIQUE\n",
				 mdname(mddev));
			conf->nr_strip_zones++;
			pr_debug("md/raid0:%s: %d zones\n",
				 mdname(mddev), conf->nr_strip_zones);
		}
	}
	pr_debug("md/raid0:%s: FINAL %d zones\n",
		 mdname(mddev), conf->nr_strip_zones);

	/*
	 * now since we have the hard sector sizes, we can make sure
	 * chunk size is a multiple of that sector size
	 */
	 // 这里 << 9 的原因: 一个扇区 512 字节
	if ((mddev->chunk_sectors << 9) % blksize) {
		pr_warn("md/raid0:%s: chunk_size of %d not multiple of block size %d\n",
			mdname(mddev),
			mddev->chunk_sectors << 9, blksize);
		err = -EINVAL;
		goto abort;
	}

	err = -ENOMEM;
	// 在内存为 strip_zone 分配空间
	// 需要分配 nr_strip_zones 大小个 struct strip_zone
	conf->strip_zone = kvzalloc_objs(struct strip_zone, conf->nr_strip_zones);
	if (!conf->strip_zone)
		goto abort;
	// 这里分配的实际大小是：设备指针 * 条带区 * 每个 zone 预留的槽位数量
	conf->devlist = kvzalloc(array3_size(sizeof(struct md_rdev *),
					     conf->nr_strip_zones,
					     mddev->raid_disks),
				 GFP_KERNEL);
	if (!conf->devlist)
		goto abort;

	// 第一个区域一定有所有的设备
	zone = &conf->strip_zone[0];
	cnt = 0;
	smallest = NULL; // 获取所有设备中的虽小扇区
	dev = conf->devlist; // devlist
	err = -EINVAL;
	rdev_for_each(rdev1, mddev) {
		int j = rdev1->raid_disk; // 设备在 raid 中的特殊编号
		                          // 下面的 new_raid_disks 
		                          // 是在阵列转换完成之后的新设备编号

		if (mddev->level == 10) { // 如果 level 是 raid10
			/* taking over a raid10-n2 array */
			j /= 2; // 需要分半, 因为是由两个 raid1 组成的 raid0
			rdev1->new_raid_disk = j;
		}

		if (mddev->level == 1) { // raid1 只有一个活跃盘
			j = 0;
			rdev1->new_raid_disk = j;
		}

		if (j < 0) { // raid_disk = -1 通常表示没有分配活动成员槽位
			pr_warn("md/raid0:%s: remove inactive devices before converting to RAID0\n",
				mdname(mddev));
			goto abort;
		}
		if (j >= mddev->raid_disks) { // j 的值超过设备总数量
			pr_warn("md/raid0:%s: bad disk number %d - aborting!\n",
				mdname(mddev), j);
			goto abort;
		}
		if (dev[j]) { // 如果这个位置被占用, 就报错
			pr_warn("md/raid0:%s: multiple devices for %d - aborting!\n",
				mdname(mddev), j);
			goto abort;
		}
		dev[j] = rdev1; // 注意，这里针对的只是第一个 zone 的内容
		                // 所以不会出现重复情况

		if (!smallest || (rdev1->sectors < smallest->sectors))
			smallest = rdev1; // 
		cnt++;
	}
	if (cnt != mddev->raid_disks) { // 如果第一个区域的参与磁盘数<总磁盘数
		pr_warn("md/raid0:%s: too few disks (%d of %d) - aborting!\n",
			mdname(mddev), cnt, mddev->raid_disks);
		goto abort;
	}
	zone->nb_dev = cnt; // 记录阵列设备数量
	zone->zone_end = smallest->sectors * cnt; // 这样第一个 zone 的结尾就是
	                                          // 最小设备扇区数 * 设备数

	curr_zone_end = zone->zone_end;

	/* now do the other zones */
	for (i = 1; i < conf->nr_strip_zones; i++) // 对剩余的条带区进行构造
	{
		int j;

		zone = conf->strip_zone + i; // 遍历到对应条带区
		dev = conf->devlist + i * mddev->raid_disks; // 遍历到 dev_list的
		                                             // 最新区域

		pr_debug("md/raid0:%s: zone %d\n", mdname(mddev), i);
		zone->dev_start = smallest->sectors; // 设备上真实开始的位置
		                                     // 第二次是越过chunk的位置
		smallest = NULL; // 注意，这里置空了 smallest !
		c = 0;

		for (j=0; j<cnt; j++) { // 符号好混乱，cnt 代表设备数
			rdev = conf->devlist[j]; 
			// 如果设备的扇区总数比新条带开始的位置还要小，说明该设备已经
			// 没有空间了，跳过
			if (rdev->sectors <= zone->dev_start) {
				pr_debug("md/raid0:%s: checking %pg ... nope\n",
					 mdname(mddev),
					 rdev->bdev);
				continue;
			}
			pr_debug("md/raid0:%s: checking %pg ..."
				 " contained as device %d\n",
				 mdname(mddev),
				 rdev->bdev, c);
			dev[c] = rdev; // 记住，这里是 disk_list 最新位置
			c++;
			if (!smallest || rdev->sectors < smallest->sectors) {
				smallest = rdev; // 这里统计的是剩余设备中最小的一个
				                 // 之后偏移可以通过 smallest - start_sectors
				                 // 实现
				pr_debug("md/raid0:%s:  (%llu) is smallest!.\n",
					 mdname(mddev),
					 (unsigned long long)rdev->sectors);
			}
		}

		zone->nb_dev = c; // 记录总数
		// 当前 zone 的实际总扇区数
		sectors = (smallest->sectors - zone->dev_start) * c; 
		pr_debug("md/raid0:%s: zone->nb_dev: %d, sectors: %llu\n",
			 mdname(mddev),
			 zone->nb_dev, (unsigned long long)sectors);
		这里是逻辑扇区
		curr_zone_end += sectors;
		zone->zone_end = curr_zone_end;

		pr_debug("md/raid0:%s: current zone start: %llu\n",
			 mdname(mddev),
			 (unsigned long long)smallest->sectors);
	}
    // 条带数为 1，总设备数为 1，走初始布局
	if (conf->nr_strip_zones == 1 || conf->strip_zone[1].nb_dev == 1) {
		conf->layout = RAID0_ORIG_LAYOUT;
	} 
	// mddev 要求使用两种布局中的一种
	else if (mddev->layout == RAID0_ORIG_LAYOUT ||
		   mddev->layout == RAID0_ALT_MULTIZONE_LAYOUT) {
		conf->layout = mddev->layout;
	} 
	// 否则查看默认布局是哪种
	else if (default_layout == RAID0_ORIG_LAYOUT ||
		   default_layout == RAID0_ALT_MULTIZONE_LAYOUT) {
		conf->layout = default_layout;
	} 
	// 否则报错
	else {
		pr_err("md/raid0:%s: cannot assemble multi-zone RAID0 with default_layout setting\n",
		       mdname(mddev));
		pr_err("md/raid0: please set raid0.default_layout to 1 or 2\n");
		err = -EOPNOTSUPP;
		goto abort;
	}

    // 如果是初始布局，从第二个扇区开始 disk_shift 应该为全局设备偏移
    // 不需要对替代布局说明，因为替代布局每次就是从 0 开始
	if (conf->layout == RAID0_ORIG_LAYOUT) {
		for (i = 1; i < conf->nr_strip_zones; i++) {
			sector_t first_sector = conf->strip_zone[i-1].zone_end;
            // 每次用计算当前扇区是第几个 chunks
			sector_div(first_sector, mddev->chunk_sectors);
			zone = conf->strip_zone + i;
			/* disk_shift is first disk index used in the zone */
			// 使用全局 disk 偏移
			zone->disk_shift = sector_div(first_sector,
						      zone->nb_dev);
		}
	}

	pr_debug("md/raid0:%s: done.\n", mdname(mddev));
	*private_conf = conf;

	return 0;
abort:
	kvfree(conf->strip_zone);
	kvfree(conf->devlist);
	kfree(conf);
	*private_conf = ERR_PTR(err);
	return err;
}
```

总结一下：

- 首先根据不同的设备情况（是否是`dm`），对基础逻辑块大小进行获取。使用算法对条带区的数量进行了计算：

  - 每有两个设备的实际扇区数量不同，就意味着多出一个条带区；

- 对条带区结构体，raid0`disk_list`进行分配，这里注意`disk_list`定义；

- 接下来，对条带区和`r0config`的数据进行初始化：

  - 对第一个条带区进行规划（这个条带区必然包含所有设备），更新`disk_list`，和一些初始偏移数据；

  - 之后对后续条带区进行初始化。

- 最后设置 layout，如果是初始布局需要把偏移换成全局设备偏移，使用替代方案起始偏移就是 0（相对偏移）。

### 由逻辑扇区找到对应条带区

函数由`find_zone`实现：

```c
static struct strip_zone *find_zone(struct r0conf *conf,
				    sector_t *sectorp)
{
	int i;
	struct strip_zone *z = conf->strip_zone;
	sector_t sector = *sectorp;

	for (i = 0; i < conf->nr_strip_zones; i++)
		if (sector < z[i].zone_end) {
			if (i)
				*sectorp = sector - z[i-1].zone_end;
			return z + i;
		}
	BUG();
}
```

逻辑很简单，因为每个`zone_end`记录的是这个块结束的逻辑扇区号，于是遍历`strip_zone`数组，只要`sector`小于该区域的最后逻辑扇区号，说明就在该条带区中。

注意，这里最后修改了`sectorp`：将其修改为该条带区中的相对扇区偏移。最终返回条带区位置。

### 确定 bio 请求对应的成员设备号和设备内相对偏移

由`map_sector`实现，选择一个成员设备，计算请求在该设备当前 zone 内的扇区偏移：

- `sector`在原始布局中是逻辑扇区号，在代替布局中是相对 zone 的扇区号；

- `sector_offset`是指向本次请求的条带区内相对偏移量；

- `mddev`：请求发往的 raid 阵列。

```c
static struct md_rdev *map_sector(struct mddev *mddev, 
                                  struct strip_zone *zone,
				                  sector_t sector, 
				                  sector_t *sector_offset)
{
	unsigned int sect_in_chunk;
	sector_t chunk;
	struct r0conf *conf = mddev->private;
	int raid_disks = conf->strip_zone[0].nb_dev; 
	unsigned int chunk_sects = mddev->chunk_sectors;

	if (is_power_of_2(chunk_sects)) { // 如果是 chunk 大小是 2 的倍数
	                                  // 这里单独拿出来是为了利用位运算加速
	    // find first zero 找到第一个 0 的位置
	    // 一个2次幂形式的数，ffz 它的反应该是找到这个数的 1 的位置
	    // 后面可以把这个变量视为 2^n 中的 n
		int chunksect_bits = ffz(~chunk_sects); 
		/* find the sector offset inside the chunk */
		// 计算在 chunk 内的扇偏移
		sect_in_chunk  = sector & (chunk_sects - 1);
		sector >>= chunksect_bits; // 现在 sector 变成 chunk 偏移
		/* chunk in zone */
		chunk = *sector_offset; // 条带区内相对偏移量（单位扇区）
		// 条带区内相对偏移量 / 扇区单位 = 条带区内哪个 chunk
		// 条带区内哪个 chunk / 设备数 = 当前 chunk 落在一个zone的第几轮循环
		sector_div(chunk, zone->nb_dev << chunksect_bits);
	} else {
	    // sector 变成逻辑 chunk 位置，sector_in_chunk 表示 chunk 内偏移
		sect_in_chunk = sector_div(sector, chunk_sects);
		// 获得条带区内的相对扇区偏移
		chunk = *sector_offset;
		// 当前 chunk 落在第几个循环中
		sector_div(chunk, chunk_sects * zone->nb_dev);
	}
	/*
	*  position the bio over the real device
	*  real sector = chunk in device + starting of zone
	*	+ the position in the chunk
	*/

    // 在第几轮循环（在一个设备上的第几个 chunk） * chunk_sect + 扇区内偏移 
    // = 在一个设备上的相对扇区偏移
	*sector_offset = (chunk * chunk_sects) + sect_in_chunk;
	// zone 偏移 * dev_list固定设备槽
	// 逻辑 chunk 位置 % 条带区设备数 得到的是当前 chunk 应该被交给的设备
	// 得到实际设备位置
	return conf->devlist[(zone - conf->strip_zone)*raid_disks
			     + sector_div(sector, zone->nb_dev)];
}
```

函数的根本目的是根据【逻辑扇区号】和【条带区的相对扇区偏移】，在对应 md 设备的 raid 阵列上找到`dev_list`上的设备：

- 首先计算了逻辑 chunk 偏移和 chunk 内扇区偏移：

  $\text{chunk\_idx} = \text{sector} \div \text{chunk\_size}$

  $\text{sect\_in\_chunk} \equiv \text{sector} \mod{  \text{chunk\_size}}$    

- 计算当前 chunk 落在第几轮设备循环，也就是落在对应设备的第几个 chunk 上：

  $\text{chunk} = \text{sector\_offset} \div  \text{nb\_dev} \div \text{chunk\_size}$

- 重新计算在一个设备上的相对扇区偏移：

  $\text{sector\_offset} = (\text{chunk} * \text{chunk\_sects}) + \text{sect\_in\_chunk}$   

- 计算在`dev_list`上的相对偏移：

  $\text{zone\_idx} * \text{raid\_disks} + \text{chunk\_idx} \% \text{nb\_dev}$

这里进行了 `chunk_size`是否为 2 次幂形式的判断，意图在使用位运算加速，这样可以更快的获得逻辑 chunk 偏移和 chunk 内的扇区偏移。

> 在代替布局下，这个 chunk_idx 是对应 zone 的 chunk 偏移，也就对应后面的chunk_idx % nb_dev 其实是在 zone 内对应到那个设备上。
>
> 这里完全符合我们前面提到的原则，一个是全局，一个是相对 zone

### 在 raid0 情景下的 submit_bio 方式



```c
static void raid0_map_submit_bio(struct mddev *mddev, struct bio *bio)
{
	struct r0conf *conf = mddev->private;
	struct strip_zone *zone;
	struct md_rdev *tmp_dev;
	sector_t bio_sector = bio->bi_iter.bi_sector;
	sector_t sector = bio_sector; 

	md_account_bio(mddev, &bio);
    // 传入的 sector 是逻辑扇区，输出的 sector 是相对一个 zone 的扇区偏移
	zone = find_zone(mddev->private, &sector);
	switch (conf->layout) {
	case RAID0_ORIG_LAYOUT:
	    // 在传统布局下，输入的是逻辑扇区偏移，流程就和我们说的没什么区别
		tmp_dev = map_sector(mddev, zone, bio_sector, &sector);
		break;
	case RAID0_ALT_MULTIZONE_LAYOUT:
	    // 在当前布局下，我们传入的是相对 zone 的逻辑扇区偏移
		tmp_dev = map_sector(mddev, zone, sector, &sector);
		break;
	default:
		WARN(1, "md/raid0:%s: Invalid layout\n", mdname(mddev));
		bio_io_error(bio);
		return;
	}

	if (unlikely(is_rdev_broken(tmp_dev))) {
		bio_io_error(bio);
		md_error(mddev, tmp_dev);
		return;
	}

	bio_set_dev(bio, tmp_dev->bdev);
	bio->bi_iter.bi_sector = sector + zone->dev_start +
		tmp_dev->data_offset;
	mddev_trace_remap(mddev, bio, bio_sector); // toDo
	mddev_check_write_zeroes(mddev, bio); // toDo
	submit_bio_noacct(bio);
}
```


