# 多设备管理驱动（Linux MD）

MD 的全称是 Multiple devices driver support ，在 `drivers/md/Kconfig`中描述为：

> Support multiple physical spindles through a single logical device.	 Required for RAID and logical volume management.

两句话的意思是：将多个物理磁盘组织起来形成一个独立的，为 RAID 和逻辑卷管理提供支持。

## 1 如何阅读

由于我们主要学习的是 RAID，于是想要从需要从`Kconfig`中找到依赖关系：

```c
config BLK_DEV_MD
	tristate "RAID support"
	    ...
config MD_LINEAR
	tristate "Linear (append) mode"
	depends on BLK_DEV_MD
		...
config MD_RAID0
	tristate "RAID-0 (striping) mode"
	depends on BLK_DEV_MD
    	...
config MD_RAID1
	tristate "RAID-1 (mirroring) mode"
	depends on BLK_DEV_MD
	help
		...
config MD_RAID10
	tristate "RAID-10 (mirrored striping) mode"
	depends on BLK_DEV_MD
		...
config MD_RAID456
	tristate "RAID-4/RAID-5/RAID-6 mode"
	depends on BLK_DEV_MD
		...
```

可以看出这些模块全部依赖于`BLK_DEV_MD`，在`Makefile`中，有这样的定义：

```makefile
md-mod-y	+= md.o
	...
obj-$(CONFIG_BLK_DEV_MD)	+= md-mod.o
```

Kbuild 有命名规定：看到组合目标`xxx.o`，就去找`xxx-y`，查看由哪些实际文件组成。也就是说，我们需要从 `mod.o`对应的源码文件`md.c`文件开始查看。

## 2 md 初始化

### 2.1 模块加载

在`md.c`中，使用`subsys_initcall(md_init)` 完成模块的加载，我们需要阅读传入的内部初始化函数`md_init`：

```c
static int __init md_init(void)
{
	int ret = md_bitmap_init();

	if (ret)
		return ret;

	ret = md_llbitmap_init();
	if (ret)
		goto err_bitmap;

	ret = -ENOMEM;
	md_misc_wq = alloc_workqueue("md_misc", WQ_PERCPU, 0);
	if (!md_misc_wq)
		goto err_misc_wq;

	ret = __register_blkdev(MD_MAJOR, "md", md_probe);
	if (ret < 0)
		goto err_md;

	ret = __register_blkdev(0, "mdp", md_probe);
	if (ret < 0)
		goto err_mdp;
	mdp_major = ret;

	register_reboot_notifier(&md_notifier);
	raid_table_header = register_sysctl("dev/raid", raid_table);

	md_geninit();
	return 0;

err_mdp:
	unregister_blkdev(MD_MAJOR, "md");
err_md:
	destroy_workqueue(md_misc_wq);
err_misc_wq:
	md_llbitmap_exit();
err_bitmap:
	md_bitmap_exit();
	return ret;
}
```

可以看到这里主要初始化了多项内容：

- bitmap：位图机制，记录可能需要重新同步的数据区域；

- md_misc_wq：工作队列，将任务处理排队，依次交给内核线程进行处理；

- blk_dev：使用`__register_blkdev`注册 md 和 mdp 设备；

  > mdp 是历史上的 `partitionable MD array`，为阵列及其分区预留设备号；

- 管理参数接口：`dev/raid`；

- 状态展示接口`md_geninit()`：创建`/proc/mdstat`，该目录由`md_seq_show`控制；

- md_notifier：关机回调函数，停止阵列线程或者 flush 数据。

> 在`Linux 7.3.1`中，开发者移除了`md_wq`工作队列，只保留了`md_nisc_wq`。

### 2.2  MD 设备创建

在前面的初始化代码中，我们看到了`md_probe`，于是想要继续寻找 MD 设备是如何初始化和申请内存的。通过搜索，可以找到函数`mddev_alloc`：

```c
static struct mddev *mddev_alloc(dev_t unit)
{
	struct mddev *new;
	int error;

	if (unit && MAJOR(unit) != MD_MAJOR) // 清除最低六位，主设备号不变
		unit &= ~((1 << MdpMinorShift) - 1);

	new = kzalloc_obj(*new);
	if (!new)
		return ERR_PTR(-ENOMEM);

	error = mddev_init(new);
	if (error)
		goto out_free_new;

	spin_lock(&all_mddevs_lock);
	if (unit) { // 如果指定主设备号
		error = -EEXIST;
		if (mddev_find_locked(unit)) // 检查制定的设备是否存在
			goto out_destroy_new;
		new->unit = unit;
		if (MAJOR(unit) == MD_MAJOR)
			new->md_minor = MINOR(unit);
		else
			new->md_minor = MINOR(unit) >> MdpMinorShift;
		new->hold_active = UNTIL_IOCTL;
	} else { // 没有指定设备号
		error = -ENODEV;
		new->unit = mddev_alloc_unit(); // 自动分配
		if (!new->unit)
			goto out_destroy_new;
		new->md_minor = MINOR(new->unit);
		new->hold_active = UNTIL_STOP;
	}

	list_add(&new->all_mddevs, &all_mddevs);
	spin_unlock(&all_mddevs_lock);
	return new;

out_destroy_new:
	spin_unlock(&all_mddevs_lock);
	mddev_destroy(new);
out_free_new:
	kfree(new);
	return ERR_PTR(error);
}
```

从这个函数中可以看到，首先使用`kzalloc_obj`对`mddev`对象进行内存申请，之后调用`mddev_init()`对设备进行初始化，最后对设备号进行初始化（如果已经指定设备号就进行查重）。

> 块设备设备号分为主设备号和次设备号，比如 MD 的主设备号`MD_MAJOR`就是 9，次设备号可以是 0、1、2、3 ... 具体对应设备名称为 `md0`、`md1`、`md2` ...

通过阅读源码，我们可以得出调用链：

`md_probe->md_alloc_and_put->md_alloc->mddev_alloc`

- `md_probe`主要负责排除次设备号大于等于 512 的设备；

- `md_alloc_and_put`主要负责返回初始化报错，并且归还创建者的临时引用；

- `md_alloc`主要负责实现初始化前的清理、块设备注册，建立设备设接口。

值得注意的是，这个是旧的 md 初始化方法，在询问了 AI 之后，我找到了新的调用路径：`add_named_array->md_alloc_and_put->md_alloc->mddev_alloc`。值得注意的是，`add_named_array` 中：

- 对用户输入的字符串进行整理和长度检查；

- 根据用户自定义命名或者自动命名向`md_alloc_and_put`传入参数。

上述调用路径都是在用户态创建一个 md 设备之后的内核调用栈，而用户态的管理工具就是 `mdadm`，暂时不详细展开。现代 `mdadm --create` 通常通过 `new_array` 请求内核创建 MD 设备，新设备已完成基础初始化，但尚未组装和启动。

### 2.1 MD `ioctl` 指令

在学习完 MD 的启动过程之后，我们需要了解 MD 是如何初始化和组装成员设备的，这些功能由`md_ioctl`实现：

```c
static int md_ioctl(struct block_device *bdev, blk_mode_t mode,
			unsigned int cmd, unsigned long arg)
{
	int err = 0;
	unsigned int noio_flags = 0;
	void __user *argp = (void __user *)arg;
	struct mddev *mddev = NULL;
	bool suspend;

	err = md_ioctl_valid(cmd);
	if (err)
		return err;

	/*
	 * Commands dealing with the RAID driver but not any
	 * particular array:
	 */
	if (cmd == RAID_VERSION)
		return get_version(argp);

	/*
	 * Commands creating/starting a new array:
	 */

	mddev = bdev->bd_disk->private_data;

	/* Some actions do not requires the mutex */
	switch (cmd) {
	case GET_ARRAY_INFO:
		if (!mddev->raid_disks && !mddev->external)
			return -ENODEV;
		return get_array_info(mddev, argp);

	case GET_DISK_INFO:
		if (!mddev->raid_disks && !mddev->external)
			return -ENODEV;
		return get_disk_info(mddev, argp);

	case SET_DISK_FAULTY:
		return set_disk_faulty(mddev, new_decode_dev(arg));

	case GET_BITMAP_FILE:
		return get_bitmap_file(mddev, argp);
	}

	if (cmd == STOP_ARRAY || cmd == STOP_ARRAY_RO) {
		/* Need to flush page cache, and ensure no-one else opens
		 * and writes
		 */
		err = mddev_set_closing_and_sync_blockdev(mddev, 1);
		if (err)
			return err;
	}

	if (!md_is_rdwr(mddev))
		flush_work(&mddev->sync_work);

	suspend = md_ioctl_need_suspend(cmd);
	err = suspend ? mddev_suspend_and_lock(mddev) : mddev_lock(mddev);
	if (err) {
		pr_debug("md: ioctl lock interrupted, reason %d, cmd %d\n",
			 err, cmd);
		goto out;
	}
	if (suspend)
		noio_flags = memalloc_noio_save();

	if (cmd == SET_ARRAY_INFO) {
		err = __md_set_array_info(mddev, argp);
		goto unlock;
	}

	/*
	 * Commands querying/configuring an existing array:
	 */
	/* if we are not initialised yet, only ADD_NEW_DISK, STOP_ARRAY,
	 * RUN_ARRAY, and GET_ and SET_BITMAP_FILE are allowed */
	if ((!mddev->raid_disks && !mddev->external)
	    && cmd != ADD_NEW_DISK && cmd != STOP_ARRAY
	    && cmd != RUN_ARRAY && cmd != SET_BITMAP_FILE
	    && cmd != GET_BITMAP_FILE) {
		err = -ENODEV;
		goto unlock;
	}

	/*
	 * Commands even a read-only array can execute:
	 */
	switch (cmd) {
	case RESTART_ARRAY_RW:
		err = restart_array(mddev);
		goto unlock;

	case STOP_ARRAY:
		err = do_md_stop(mddev, 0);
		goto unlock;

	case STOP_ARRAY_RO:
		if (mddev->pers)
			err = md_set_readonly(mddev);
		goto unlock;

	case HOT_REMOVE_DISK:
		err = hot_remove_disk(mddev, new_decode_dev(arg));
		goto unlock;

	case ADD_NEW_DISK:
		/* We can support ADD_NEW_DISK on read-only arrays
		 * only if we are re-adding a preexisting device.
		 * So require mddev->pers and MD_DISK_SYNC.
		 */
		if (mddev->pers) {
			mdu_disk_info_t info;
			if (copy_from_user(&info, argp, sizeof(info)))
				err = -EFAULT;
			else if (!(info.state & (1<<MD_DISK_SYNC)))
				/* Need to clear read-only for this */
				break;
			else
				err = md_add_new_disk(mddev, &info);
			goto unlock;
		}
		break;
	}

	/*
	 * The remaining ioctls are changing the state of the
	 * superblock, so we do not allow them on read-only arrays.
	 */
	if (!md_is_rdwr(mddev) && mddev->pers) {
		if (mddev->ro != MD_AUTO_READ) {
			err = -EROFS;
			goto unlock;
		}
		mddev->ro = MD_RDWR;
		sysfs_notify_dirent_safe(mddev->sysfs_state);
		set_bit(MD_RECOVERY_NEEDED, &mddev->recovery);
		/* mddev_unlock will wake thread */
		/* If a device failed while we were read-only, we
		 * need to make sure the metadata is updated now.
		 */
		if (test_bit(MD_SB_CHANGE_DEVS, &mddev->sb_flags)) {
			mddev_unlock(mddev);
			wait_event(mddev->sb_wait,
				   !test_bit(MD_SB_CHANGE_DEVS, &mddev->sb_flags) &&
				   !test_bit(MD_SB_CHANGE_PENDING, &mddev->sb_flags));
			mddev_lock_nointr(mddev);
		}
	}

	switch (cmd) {
	case ADD_NEW_DISK:
	{
		mdu_disk_info_t info;
		if (copy_from_user(&info, argp, sizeof(info)))
			err = -EFAULT;
		else
			err = md_add_new_disk(mddev, &info);
		goto unlock;
	}

	case CLUSTERED_DISK_NACK:
		if (mddev_is_clustered(mddev))
			mddev->cluster_ops->new_disk_ack(mddev, false);
		else
			err = -EINVAL;
		goto unlock;

	case HOT_ADD_DISK:
		err = hot_add_disk(mddev, new_decode_dev(arg));
		goto unlock;

	case RUN_ARRAY:
		err = do_md_run(mddev);
		goto unlock;

	case SET_BITMAP_FILE:
		err = set_bitmap_file(mddev, (int)arg);
		goto unlock;

	default:
		err = -EINVAL;
		goto unlock;
	}

unlock:
	if (mddev->hold_active == UNTIL_IOCTL &&
	    err != -EINVAL)
		mddev->hold_active = 0;

	if (suspend) {
		memalloc_noio_restore(noio_flags);
		mddev_unlock_and_resume(mddev);
	} else {
		mddev_unlock(mddev);
	}

out:
	if (cmd == STOP_ARRAY_RO || (err && cmd == STOP_ARRAY))
		clear_bit(MD_CLOSING, &mddev->flags);
	return err;
}
```

函数其实很简单，就是对于用户态传入的之一个`ioctl`指令，使用对应的内核函数进行处理，在头函数文件下，有如下内容：

```c
/* status */
#define RAID_VERSION		_IOR (MD_MAJOR, 0x10, mdu_version_t)
#define GET_ARRAY_INFO		_IOR (MD_MAJOR, 0x11, mdu_array_info_t)
#define GET_DISK_INFO		_IOR (MD_MAJOR, 0x12, mdu_disk_info_t)
#define RAID_AUTORUN		_IO (MD_MAJOR, 0x14)
#define GET_BITMAP_FILE		_IOR (MD_MAJOR, 0x15, mdu_bitmap_file_t)

/* configuration */
#define CLEAR_ARRAY		    _IO (MD_MAJOR, 0x20)
#define ADD_NEW_DISK		_IOW (MD_MAJOR, 0x21, mdu_disk_info_t)
#define HOT_REMOVE_DISK		_IO (MD_MAJOR, 0x22)
#define SET_ARRAY_INFO		_IOW (MD_MAJOR, 0x23, mdu_array_info_t)
#define SET_DISK_INFO		_IO (MD_MAJOR, 0x24)
#define WRITE_RAID_INFO		_IO (MD_MAJOR, 0x25)
#define UNPROTECT_ARRAY		_IO (MD_MAJOR, 0x26)
#define PROTECT_ARRAY		_IO (MD_MAJOR, 0x27)
#define HOT_ADD_DISK		_IO (MD_MAJOR, 0x28)
#define SET_DISK_FAULTY		_IO (MD_MAJOR, 0x29)
#define HOT_GENERATE_ERROR	_IO (MD_MAJOR, 0x2a)
#define SET_BITMAP_FILE		_IOW (MD_MAJOR, 0x2b, int)

/* usage */
#define RUN_ARRAY		    _IOW (MD_MAJOR, 0x30, mdu_param_t)
/*  0x31 was START_ARRAY  */
#define STOP_ARRAY		    _IO (MD_MAJOR, 0x32)
#define STOP_ARRAY_RO		_IO (MD_MAJOR, 0x33)
#define RESTART_ARRAY_RW	_IO (MD_MAJOR, 0x34)
#define CLUSTERED_DISK_NACK	_IO (MD_MAJOR, 0x35)
```

这些都是`ioctl`指令：

- `_IOW`表示从用户到内核，用户写入指令；

- `_IOR`表示从内核到用户，用户从内核读取信息；

> 后面的括号中为：(类别，命令编号， 参数类别)
>
> 比如对`#define RUN_ARRAY		_IOW (MD_MAJOR, 0x30, mdu_param_t)`
>
> 用户写入的指令就是`ioctl(fd, RUN_ARRAY, <mdu_param_t> val)`

这里我们最关注的是：

- `SET_ARRAY_INFO` ：设置阵列信息；

- `ADD_NEW_DISK`：添加磁盘到阵列；

- `RUN_ARRAY`：运行阵列。

于是在下一小节中，我们查看这几个重要的阵列信息。

### 2.2 MD 组建成员设备

#### 2.2.1 `md_set_array_info`

在本函数中，主要实现的是设置阵列信息。在这个函数之外，还有一个 warpper 函数用于读取用户态信息：

```c
static int __md_set_array_info(struct mddev *mddev, void __user *argp)
{
	mdu_array_info_t info;
	int err;

    // 从用户态读取一个 mdu_array_info_t info
	if (!argp)
		memset(&info, 0, sizeof(info));
	else if (copy_from_user(&info, argp, sizeof(info)))
		return -EFAULT;

    // 如果这个阵列已经有了 RAID 设置，调用 update_array_info 更新
	if (mddev->pers) {
		err = update_array_info(mddev, &info);
		if (err)
			pr_warn("md: couldn't update array info. %d\n", err);
		return err;
	}

    // 如果 disks 非空，说明已经有设备了
	if (!list_empty(&mddev->disks)) {
		pr_warn("md: array %s already has disks!\n", mdname(mddev));
		return -EBUSY;
	}

    // 有 raid_disks 说明已经初始化了
	if (mddev->raid_disks) {
		pr_warn("md: array %s already initialised!\n", mdname(mddev));
		return -EBUSY;
	}
    
    // 调用底层函数
	err = md_set_array_info(mddev, &info);
	if (err)
		pr_warn("md: couldn't set array info. %d\n", err);

	return err;
}
```

这里主要对几种情况进行排查：

- 对于已经有 RAID personality 的设备，尝试调用`update_array_info`进行更新；

- 对于已经有成员盘的设备或者已经设置初始 RAID 槽位的设备（没有对应 RAID pers），直接报错。

这里有一个疑问，为什么前者可以进行更新，后者就不行呢？

原因在于：`update_array_info`会先检查已有配置，再尝试受限修改。如果要进行容量、成员数量、布局等变更，需要对应 RAID 提供 `resize`、`reshape` 的能力。如果成员已经加入，或者配置已经建立，直接覆盖会导致一致性问题。

主要的功能在`md_set_array_info`中，函数有两个功能：

- 旧式创建，用户传入配置参数，进行阵列初始化，此时 raid_disks 不为 0；

- 组装阵列，用户指定元数据格式，内核从成员盘恢复阵列配置。

```c
int md_set_array_info(struct mddev *mddev, struct mdu_array_info_s *info)
{
	if (info->raid_disks == 0) {
		/* just setting version number for superblock loading */
		if (info->major_version < 0 ||
		    info->major_version >= ARRAY_SIZE(super_types) ||
		    super_types[info->major_version].name == NULL) {
			/* maybe try to auto-load a module? */
			pr_warn("md: superblock version %d not known\n",
				info->major_version);
			return -EINVAL;
		}
		mddev->major_version = info->major_version;
		mddev->minor_version = info->minor_version;
		mddev->patch_version = info->patch_version;
		mddev->persistent = !info->not_persistent;
		/* ensure mddev_put doesn't delete this now that there
		 * is some minimal configuration.
		 */
		mddev->ctime         = ktime_get_real_seconds();
		return 0;
	}
	mddev->major_version = MD_MAJOR_VERSION;
	mddev->minor_version = MD_MINOR_VERSION;
	mddev->patch_version = MD_PATCHLEVEL_VERSION;
	mddev->ctime         = ktime_get_real_seconds();

	mddev->level         = info->level;
	mddev->clevel[0]     = 0;
	mddev->dev_sectors   = 2 * (sector_t)info->size;
	mddev->raid_disks    = info->raid_disks;
	/* don't set md_minor, it is determined by which /dev/md* was
	 * openned
	 */
	if (info->state & (1<<MD_SB_CLEAN))
		mddev->resync_offset = MaxSector;
	else
		mddev->resync_offset = 0;
	mddev->persistent    = ! info->not_persistent;
	mddev->external	     = 0;

	mddev->layout        = info->layout;
	if (mddev->level == 0)
		/* Cannot trust RAID0 layout info here */
		mddev->layout = -1;
	mddev->chunk_sectors = info->chunk_size >> 9;

	if (mddev->persistent) {
		mddev->max_disks = MD_SB_DISKS;
		mddev->flags = 0;
		mddev->sb_flags = 0;
	}
	set_bit(MD_SB_CHANGE_DEVS, &mddev->sb_flags);

	mddev->bitmap_info.default_offset = MD_SB_BYTES >> 9;
	mddev->bitmap_info.default_space = 64*2 - (MD_SB_BYTES >> 9);
	mddev->bitmap_info.offset = 0;

	mddev->reshape_position = MaxSector;

	/*
	 * Generate a 128 bit UUID
	 */
	get_random_bytes(mddev->uuid, 16);

	mddev->new_level = mddev->level;
	mddev->new_chunk_sectors = mddev->chunk_sectors;
	mddev->new_layout = mddev->layout;
	mddev->delta_disks = 0;
	mddev->reshape_backwards = 0;

	return 0;
}
```

在官方注释中，有这样一段话：当 `raid_disks` 数量大于 0 的时候，将创建版本是 0.90.0  的 raid 阵列，这是对老版本的兼容。我们需要读取的其实是新版本的代码，于是只需要读取在组装阵列条件下的代码就好：

- 设置了主设备属性和次设备版本；

- 设置了是否有持久化存储，一般都是 true；

- 设置阵列创建时间。

在之后的 `add_new_disk`，才对真正的成员设备进行初始化。

#### 2.2.2 `md_add_new_disk`

与前一个函数不同，这个函数没有 wrapper，参数读取和处理在`md_ioctl`完成实现：

```c
int md_add_new_disk(struct mddev *mddev, struct mdu_disk_info_s *info)
{
	struct md_rdev *rdev;
	dev_t dev = MKDEV(info->major,info->minor);

	if (mddev_is_clustered(mddev) &&
		!(info->state & ((1 << MD_DISK_CLUSTER_ADD) | (1 << MD_DISK_CANDIDATE)))) {
		pr_warn("%s: Cannot add to clustered mddev.\n",
			mdname(mddev));
		return -EINVAL;
	}

	if (info->major != MAJOR(dev) || info->minor != MINOR(dev))
		return -EOVERFLOW;

	if (!mddev->raid_disks) {
		int err;
		/* expecting a device which has a superblock */
		rdev = md_import_device(dev, mddev->major_version, mddev->minor_version);
		if (IS_ERR(rdev)) {
			pr_warn("md: md_import_device returned %ld\n",
				PTR_ERR(rdev));
			return PTR_ERR(rdev);
		}
		if (!list_empty(&mddev->disks)) {
			struct md_rdev *rdev0
				= list_entry(mddev->disks.next,
					     struct md_rdev, same_set);
			err = super_types[mddev->major_version]
				.load_super(rdev, rdev0, mddev->minor_version);
			if (err < 0) {
				pr_warn("md: %pg has different UUID to %pg\n",
					rdev->bdev,
					rdev0->bdev);
				export_rdev(rdev);
				return -EINVAL;
			}
		}
		err = bind_rdev_to_array(rdev, mddev);
		if (err)
			export_rdev(rdev);
		return err;
	}
    ...
    ...
    ...
    return 0;
}
```

函数很长，但对于初学来说有意义的就是上面这几行：

- 首先根据主设备号和次设备号算出`dev_t`（32 位，12 位主设备 + 20 位次设备）

- 检查设备号是否存在溢出情况；

- 由于当前`raid_disks`为 0，于是使用`md_import_device`进行设备引入；

- 如果已经有成员，检查新成员是否在同一个阵列中；

- 将新成员绑定到阵列上，实现`rdev`和`mddev`关联。

  > rdev 和 mddev 之间的关系：`mddev` 管理整个 MD 阵列，`rdev` 描述阵列中的一个成员设备；
  >
  > `mddev->disks`：阵列的成员链表；
  > `rdev->mddev` ： 这个成员所属的阵列；
  > `rdev->bdev` ：这个成员对应的底层块设备。

我门需要查看函数`md_import_device`，了解设备是怎么导入的：

```c
static struct md_rdev *md_import_device(dev_t newdev, int super_format, int super_minor)
{
	struct md_rdev *rdev;
	sector_t size;
	int err;

	rdev = kzalloc_obj(*rdev); // 创建并为 rdev 实例申请内存空间
	if (!rdev)
		return ERR_PTR(-ENOMEM);

	err = md_rdev_init(rdev); // 初始化 rdev
	if (err)
		goto out_free_rdev;
	err = alloc_disk_sb(rdev); // 为 rdev 申请一个 page，存放磁盘超级块信息
	if (err)
		goto out_clear_rdev;
    // 打开 bdev 文件
	rdev->bdev_file = bdev_file_open_by_dev(newdev,
			BLK_OPEN_READ | BLK_OPEN_WRITE,
			super_format == -2 ? &claim_rdev : rdev, NULL);
	if (IS_ERR(rdev->bdev_file)) {
		pr_warn("md: could not open device unknown-block(%u,%u).\n",
			MAJOR(newdev), MINOR(newdev));
		err = PTR_ERR(rdev->bdev_file);
		goto out_clear_rdev;
	}
	rdev->bdev = file_bdev(rdev->bdev_file); // 加载 rdev 实例到 bdev 上

	kobject_init(&rdev->kobj, &rdev_ktype);

	size = bdev_nr_bytes(rdev->bdev) >> BLOCK_SIZE_BITS;
	if (!size) {
		pr_warn("md: %pg has zero or unknown size, marking faulty!\n",
			rdev->bdev);
		err = -EINVAL;
		goto out_blkdev_put;
	}

	if (super_format >= 0) {
		err = super_types[super_format].
			load_super(rdev, NULL, super_minor);
		if (err == -EINVAL) {
			pr_warn("md: %pg does not have a valid v%d.%d superblock, not importing!\n",
				rdev->bdev,
				super_format, super_minor);
			goto out_blkdev_put;
		}
		if (err < 0) {
			pr_warn("md: could not read %pg's sb, not importing!\n",
				rdev->bdev);
			goto out_blkdev_put;
		}
	}

	return rdev;

out_blkdev_put:
	fput(rdev->bdev_file);
out_clear_rdev:
	md_rdev_clear(rdev);
out_free_rdev:
	kfree(rdev);
	return ERR_PTR(err);
}
```

- 函数首先创建并为 `rdev`实例申请空间，之后进行初始化。随后使用`alloc_disk_sb`为磁盘申请一个 page，用于存放超级块信息；

- 按照设备号打开对应`bdev`（`bdev_file`），从中加载出`bdev`对象挂载到`rdev`上；

- 初始化`rdev`阵列的`kobject`结构；

- 对于我们学习的新版 md 设备，使用`super_types[super_format].load_super()`读入超级块阵列信息；

`load_super`使用了`super_1_load`方法，这个函数主要是从磁盘超级块中读取信息存到`rdev->sb_page`，部分元数据在解析之后保存到`rdev`下面的成员变量中。

之后通过`bind_rdev_to_array`完成`struct mddev`和`struct md_rdev`之间的连接：

```c
static int bind_rdev_to_array(struct md_rdev *rdev, struct mddev *mddev)
{
	char b[BDEVNAME_SIZE];
	int err;

	// 检查磁盘是否已经进入 mddev 防止重复添加
	if (find_rdev(mddev, rdev->bdev->bd_dev))
		return -EEXIST;

    // 
	if (rdev_read_only(rdev) && mddev->pers)
		return -EROFS;

	/* make sure rdev->sectors exceeds mddev->dev_sectors */
	if (!test_bit(Journal, &rdev->flags) &&
	    rdev->sectors &&
	    (mddev->dev_sectors == 0 || rdev->sectors < mddev->dev_sectors)) {
		if (mddev->pers) {
			/* Cannot change size, so fail
			 * If mddev->level <= 0, then we don't care
			 * about aligning sizes (e.g. linear)
			 */
			if (mddev->level > 0)
				return -ENOSPC;
		} else
			mddev->dev_sectors = rdev->sectors;
	}

	/* Verify rdev->desc_nr is unique.
	 * If it is -1, assign a free number, else
	 * check number is not in use
	 */
	rcu_read_lock();
	// 保证 desc_nr 唯一
	// desc_nr 是超级块中设备描述符的编号
	if (rdev->desc_nr < 0) {
		int choice = 0;
		if (mddev->pers)
			choice = mddev->raid_disks;
		while (md_find_rdev_nr_rcu(mddev, choice))
			choice++;
		rdev->desc_nr = choice;
	} else {
		if (md_find_rdev_nr_rcu(mddev, rdev->desc_nr)) {
			rcu_read_unlock();
			return -EBUSY;
		}
	}
	rcu_read_unlock();
	if (!test_bit(Journal, &rdev->flags) &&
	    mddev->max_disks && rdev->desc_nr >= mddev->max_disks) {
		pr_warn("md: %s: array is limited to %d devices\n",
			mdname(mddev), mddev->max_disks);
		return -EBUSY;
	}
	// 得到成员设备名称，并把其中可能出现的 / 替换为 !
	// 方便用作 sysfs 目录名称
	snprintf(b, sizeof(b), "%pg", rdev->bdev);
	strreplace(b, '/', '!');

	rdev->mddev = mddev;
	pr_debug("md: bind<%s>\n", b);

	if (mddev->raid_disks)
		mddev_create_serial_pool(mddev, rdev);

	if ((err = kobject_add(&rdev->kobj, &mddev->kobj, "dev-%s", b)))
		goto fail;

	// 将信息注册到 sysfs 下
	// 创建指向底层块设备对象的 block 链接
	err = sysfs_create_link(&rdev->kobj, bdev_kobj(rdev->bdev), "block");
	rdev->sysfs_state = sysfs_get_dirent_safe(rdev->kobj.sd, "state");
	rdev->sysfs_unack_badblocks =
		sysfs_get_dirent_safe(rdev->kobj.sd, "unacknowledged_bad_blocks");
	rdev->sysfs_badblocks =
		sysfs_get_dirent_safe(rdev->kobj.sd, "bad_blocks");

    // 加入阵列成员列表
	list_add_rcu(&rdev->same_set, &mddev->disks);
	bd_link_disk_holder(rdev->bdev, mddev->gendisk);

	return 0;

 fail:
	pr_warn("md: failed to register dev-%s for %s\n",
		b, mdname(mddev));
	mddev_destroy_serial_pool(mddev, rdev);
	return err;
}
```




