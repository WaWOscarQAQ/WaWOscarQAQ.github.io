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

注意`strip_zone`其实是一个指向数组首元素的指针，方便多`strip_zone`管理。

### 条带区初始化

在函数`create_strip_zones`中，初步实现了条带的初始化：

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
	// 
	conf->devlist = kvzalloc(array3_size(sizeof(struct md_rdev *),
					     conf->nr_strip_zones,
					     mddev->raid_disks),
				 GFP_KERNEL);
	if (!conf->devlist)
		goto abort;

	/* The first zone must contain all devices, so here we check that
	 * there is a proper alignment of slots to devices and find them all
	 */
	zone = &conf->strip_zone[0];
	cnt = 0;
	smallest = NULL;
	dev = conf->devlist;
	err = -EINVAL;
	rdev_for_each(rdev1, mddev) {
		int j = rdev1->raid_disk;

		if (mddev->level == 10) {
			/* taking over a raid10-n2 array */
			j /= 2;
			rdev1->new_raid_disk = j;
		}

		if (mddev->level == 1) {
			/* taiking over a raid1 array-
			 * we have only one active disk
			 */
			j = 0;
			rdev1->new_raid_disk = j;
		}

		if (j < 0) {
			pr_warn("md/raid0:%s: remove inactive devices before converting to RAID0\n",
				mdname(mddev));
			goto abort;
		}
		if (j >= mddev->raid_disks) {
			pr_warn("md/raid0:%s: bad disk number %d - aborting!\n",
				mdname(mddev), j);
			goto abort;
		}
		if (dev[j]) {
			pr_warn("md/raid0:%s: multiple devices for %d - aborting!\n",
				mdname(mddev), j);
			goto abort;
		}
		dev[j] = rdev1;

		if (!smallest || (rdev1->sectors < smallest->sectors))
			smallest = rdev1;
		cnt++;
	}
	if (cnt != mddev->raid_disks) {
		pr_warn("md/raid0:%s: too few disks (%d of %d) - aborting!\n",
			mdname(mddev), cnt, mddev->raid_disks);
		goto abort;
	}
	zone->nb_dev = cnt;
	zone->zone_end = smallest->sectors * cnt;

	curr_zone_end = zone->zone_end;

	/* now do the other zones */
	for (i = 1; i < conf->nr_strip_zones; i++)
	{
		int j;

		zone = conf->strip_zone + i;
		dev = conf->devlist + i * mddev->raid_disks;

		pr_debug("md/raid0:%s: zone %d\n", mdname(mddev), i);
		zone->dev_start = smallest->sectors;
		smallest = NULL;
		c = 0;

		for (j=0; j<cnt; j++) {
			rdev = conf->devlist[j];
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
			dev[c] = rdev;
			c++;
			if (!smallest || rdev->sectors < smallest->sectors) {
				smallest = rdev;
				pr_debug("md/raid0:%s:  (%llu) is smallest!.\n",
					 mdname(mddev),
					 (unsigned long long)rdev->sectors);
			}
		}

		zone->nb_dev = c;
		sectors = (smallest->sectors - zone->dev_start) * c;
		pr_debug("md/raid0:%s: zone->nb_dev: %d, sectors: %llu\n",
			 mdname(mddev),
			 zone->nb_dev, (unsigned long long)sectors);

		curr_zone_end += sectors;
		zone->zone_end = curr_zone_end;

		pr_debug("md/raid0:%s: current zone start: %llu\n",
			 mdname(mddev),
			 (unsigned long long)smallest->sectors);
	}

	if (conf->nr_strip_zones == 1 || conf->strip_zone[1].nb_dev == 1) {
		conf->layout = RAID0_ORIG_LAYOUT;
	} else if (mddev->layout == RAID0_ORIG_LAYOUT ||
		   mddev->layout == RAID0_ALT_MULTIZONE_LAYOUT) {
		conf->layout = mddev->layout;
	} else if (default_layout == RAID0_ORIG_LAYOUT ||
		   default_layout == RAID0_ALT_MULTIZONE_LAYOUT) {
		conf->layout = default_layout;
	} else {
		pr_err("md/raid0:%s: cannot assemble multi-zone RAID0 with default_layout setting\n",
		       mdname(mddev));
		pr_err("md/raid0: please set raid0.default_layout to 1 or 2\n");
		err = -EOPNOTSUPP;
		goto abort;
	}

	if (conf->layout == RAID0_ORIG_LAYOUT) {
		for (i = 1; i < conf->nr_strip_zones; i++) {
			sector_t first_sector = conf->strip_zone[i-1].zone_end;

			sector_div(first_sector, mddev->chunk_sectors);
			zone = conf->strip_zone + i;
			/* disk_shift is first disk index used in the zone */
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


