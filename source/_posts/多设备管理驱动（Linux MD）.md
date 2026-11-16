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

### 1.1 模块加载

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

- 状态展示接口`md_geninit()`；

- md_notifier：关机回调函数，停止阵列线程或者 flush 数据。

> 在`Linux 7.3.1`中，开发者移除了`md_wq`工作队列，只保留了`md_nisc_wq`。




