# ublk 用户空间块设备驱动程序

项目核心原理：让 Linux 提供一个普通块设备，把这个设备背后的读写处理逻辑交给用户态程序实现。

ublk 有三个重要角色：

- **`ublk_drv`内核驱动**：接入 Linux 块层，接收上层读写请求，把请求交给用户态；
- **`libublksrv`用户态库**： 封装设备管理、请求接收、队列处理和结果提交；
- **`target`后端实现**： 处理收到的请求，直接向底层发送IO请求；

基本过程如下：

1. 内核文件系统对`ublk`设置的虚拟块设备进行请求，到达 `ublk_drv`；

2. `ublk_drv`将请求交给`libublksrv`，用户态通过队列编号和`tag`找到对应的请求描述符；

3. `libublksrv`把请求发给`target`（具体的后端实现），`target`决定块请求的处理逻辑，再将处理结果发给具体的磁盘、虚拟磁盘、网络存储。

其中需要注意的是，`libublksrv`和  `target` 在一个用户态服务进程中。

## 流程

这里有两个重要术语：

- `SQE`：交给 `io_uring` 的操作；

- `CQE`：操作产生的完成事件；

首先，`libublksrv`（后文简称 `srv`）提前向 `ublkdrv` （后文简称`drv`）提交等待接收请求的命令。`srv` 初始化 ublk 请求队列时，先把内核提供的请求描述符区域映射进自己的地址空间：

```c
off = UBLKSRV_CMD_BUF_OFFSET + q_id * queue_max_cmd_buf_sz();
q->io_cmd_buf = mmap(
    0, cmd_buf_size, PROT_READ,
    MAP_SHARED | MAP_POPULATE,
    dev->cdev_fd, off
);
```

> 一个 ublk 设备可以配置多个队列。每个队列都有：
>
> - **`q_id`**：队列编号
> - **`queue_depth`**：队列容纳请求数
> - **`tag`**：队内请求槽位编号
> - **共享描述符区域**：内核在其中填写每个请求细节

每个队列对应自己的映射区域，保存**请求描述符**，结构体如下：

```c
struct ublksrv_io_desc {
	/* op: bit 0-7, flags: bit 8-31 */
	__u32		op_flags; // 低 8 位是操作类型, 高 24 位请求标志

	union {
	    // 读写长度, 单位是扇区（512 字节）
		__u32		nr_sectors; /
		// 报告
		__u32		nr_zones; /* for UBLK_IO_OP_REPORT_ZONES */
	};

	/* start sector for this io */
	__u64		start_sector; // 开始的扇区数

    // 
	__u64		addr;
};
```

之后，srv 为队列中每个 tag 准备一个 FETCH 命令：


