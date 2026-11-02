---
title: Linux 存储栈
date: 2026-11-02
tags: [学习笔记, Linux Kernel, 存储栈]
thumbnail: /images/covers/Linux_storage_stack.png
cover: /images/covers/Linux_storage_stack.png
excerpt: 简单了解 Linux 存储栈的架构
---

# Linux 存储栈

## 1 Linux 块设备层 IO 请求

在用户空间发起读写请求时，如果 page cache 没有需要的数据，需要从存储介质中进行读取/写入。Linux 为了兼容各种各样的存储设备，同样抽象出了通用块层作为统一接口向上层文件系统或页缓存提供高效读写服务。

在块通用块层，Linux 使用 `struct bio`和`struct request`这两种结构体抽象，把上层的IO请求与下层实际能够高效处理 IO 单元进行了完美的解耦和桥接，实现了高性能、高兼容性的通用存储框架：

- 上层文件系统将需求包装成 `struct bio`，表达自己要读写什么地方的多少数据；

- 通用块层在`struct bio`基础上进一步将IO请求处理成 `struct request`结构，并下发给设备驱动处理；

其中，`bio`和`request`之间的关系可以是：

- 多个`bio`合并到一个 `request`；

- 一个`bio`拆解成多个`request`；

通用块层在`submit_bio`到`queue_rq`这段对话中，负责从`bio->request`的调度，极大提升了系统IO性能和硬件利用率

## 1.1 `struct bio`

是文件系统/页缓存/RAID/dm 到通用块层的IO请求描述，主要包括：

- 数据页；

- IO 方向；

- 起始扇区；

其中`struct bio`定义于`include/linux/blk_types.h`中：

```c
struct bio {
	struct bio		*bi_next;	// bio 之间串联成链表，方便 request quene 调度
	struct block_device	*bi_bdev; // bio 要操作的设备指针
	blk_opf_t		bi_opf;	// 表明 bio 执行什么操作的
	                        // 低八位操作类型
	                        // 高 24 位代表请求 flag
	unsigned short		bi_flags; // 这个 bio 怎么被管理和请求, 对象内部标志
	unsigned short		bi_ioprio; // IO 优先级
	enum rw_hint		bi_write_hint; // 写入数据的预期生命周期提示
	u8			bi_write_stream; // 写入流的分组, 用于写入分类分组
	blk_status_t		bi_status; // bio 执行结果, 记录 IO 操作的返回状态

    // 这一项表示所有 bi_io_vec 之间的地址偏移量中，
    // 最低的 "1" 出现在第几位
    // 一个 BIO 的 bi_io_vec 可以描述多段物理上不连续的内存
    // IOMMU 在进行内存映射的时候，需要对这些向量内存对其做检查
	u8			bi_bvec_gap_bit;
	
    // 代表一个 bio 链中还有几个 bio 没有处理完，默认值为 1
    // 对于链类型的 bio 来说，回调函数为 bio_chain_endio
    // 函数回调流程为 bio_chain_endio -> bio_endio -> bio_remaining_done
    // 此时该数值 -1
    // 这个值如果不是 0 说明当前链中的 bio 还没有处理完
    // bio_endio 直接返回, 只有当 这个数值为 0 时，bio_endio才会继续执行
	atomic_t		__bi_remaining;

	/* The actual vec list, preserved by bio_reset() */
	// 其中记录内存的页数、长度、起始位置
	// 注意，这里每个 bio_vec 记录一段内存片段
	struct bio_vec		*bi_io_vec;
    // struct bvec_iter
    // {
	//     sector_t		bi_sector; 在哪个扇区
	//     unsigned int		bi_size; 还剩下多少没有读
	//     unsigned int		bi_idx; // 读到几号 bi_vect
	//     unsigned int		bi_offset; // 现在正在读取的 bvec 的 offset
    // }
	struct bvec_iter	bi_iter; // 描述当前 bio 的遍历状态
	                             // 存储器端启示位置, 还有多少字节需要写
	                             // 内存端当前操作的 vector 是哪个,
	                             // 当前 vector 中完成了多少字节

	union {
		/* for polled bios: */
		blk_qc_t		bi_cookie;
		/* for plugged zoned writes only: */
		unsigned int		__bi_nr_segments;
	};
	bio_end_io_t		*bi_end_io;
	void			*bi_private;
#ifdef CONFIG_BLK_CGROUP
	/*
	 * Represents the association of the css and request_queue for the bio.
	 * If a bio goes direct to device, it will not have a blkg as it will
	 * not have a request_queue associated with it.  The reference is put
	 * on release of the bio.
	 */
	struct blkcg_gq		*bi_blkg;
	/* Time that this bio was issued. */
	u64			issue_time_ns;
#ifdef CONFIG_BLK_CGROUP_IOCOST
	u64			bi_iocost_cost;
#endif
#endif

#ifdef CONFIG_BLK_INLINE_ENCRYPTION
	struct bio_crypt_ctx	*bi_crypt_context;
#endif

#if defined(CONFIG_BLK_DEV_INTEGRITY)
	struct bio_integrity_payload *bi_integrity; /* data integrity */
#endif

	unsigned short		bi_vcnt; // 存了多少 bio_vect

	/*
	 * Everything starting with bi_max_vecs will be preserved by bio_reset()
	 */

    // 表示一个 bio 可以容纳的 bio_vect 有多少个
	unsigned short		bi_max_vecs;
    
    // bio 引用计数, 防止被提前释放
	atomic_t		__bi_cnt;	/* pin count */

	struct bio_set		*bi_pool;
};
```

其中，一个 bio 中重要的对应指针为：

- `bi_next`串联下一个 `bio`结构体；

- `bi_vect`记录一条`bio`需要访问的连续内存片段；

- `bi_iter`负责记录现在所有`bio`结构体处理到哪里，以及正在处理的`bio_vect`是哪个，同时负责调度`bi_vect`。

- 当 `biv_cnt`小于`bi_inline_vecs`时，直接指向`bi_inline_vecs`    

![](/home/oscarw/MySite/WaWOscarQAQ.github.io/source/images/contents/Linux_Kernel/bio_struct.png)

其中，具体的`bi_opf`中的可选值如下：其中低 8 位为操作类型，高 24 位为请求处理 flag

```c
enum req_op { // 低八位
	/** @REQ_OP_READ: 从设备中读取扇区 */
	REQ_OP_READ		= (__force blk_opf_t)0,
	/** @REQ_OP_WRITE: 向设备中扇区写入内容 */
	REQ_OP_WRITE		= (__force blk_opf_t)1,
	/** @REQ_OP_FLUSH: 刷新易失性写缓存*/
	REQ_OP_FLUSH		= (__force blk_opf_t)2,
	/** @REQ_OP_DISCARD: 丢弃扇区 */
	REQ_OP_DISCARD		= (__force blk_opf_t)3,
	/** @REQ_OP_SECURE_ERASE: 安全擦除扇区 */
	REQ_OP_SECURE_ERASE	= (__force blk_opf_t)5,
	/** @REQ_OP_ZONE_APPEND: 从当前扇区的写入指针位置开始写数据 */
	REQ_OP_ZONE_APPEND	= (__force blk_opf_t)7,
	/** @REQ_OP_WRITE_ZEROES: 将扇区用 0 多次填充 */
	REQ_OP_WRITE_ZEROES	= (__force blk_opf_t)9,
	/** @REQ_OP_ZONE_OPEN: 打开管理分区 */
	REQ_OP_ZONE_OPEN	= (__force blk_opf_t)11,
	/** @REQ_OP_ZONE_CLOSE: 关闭管理分区 */
	REQ_OP_ZONE_CLOSE	= (__force blk_opf_t)13,
	/** @REQ_OP_ZONE_FINISH: 将分区标记为写满, 不再写入内容 */
	REQ_OP_ZONE_FINISH	= (__force blk_opf_t)15,
	/** @REQ_OP_ZONE_RESET: 重置一个分区写指针 */
	REQ_OP_ZONE_RESET	= (__force blk_opf_t)17,
	/** @REQ_OP_ZONE_RESET_ALL: 重置设备上的所有分区 */
	REQ_OP_ZONE_RESET_ALL	= (__force blk_opf_t)19,

    // 设备私有请求
	/* private: */
	REQ_OP_DRV_IN		= (__force blk_opf_t)34,
	REQ_OP_DRV_OUT		= (__force blk_opf_t)35,

	REQ_OP_LAST		= (__force blk_opf_t)36,
};

enum req_flag_bits {
	__REQ_FAILFAST_DEV =	/* 设备层错误直接显示失败, 不重试 */
		REQ_OP_BITS,
	__REQ_FAILFAST_TRANSPORT, /* 传输错误不重试 */
	__REQ_FAILFAST_DRIVER,	/* 驱动错误不重试 */
	__REQ_SYNC,		/* 请求是同步的 */
	__REQ_META,		/* 请求元数据 */
	__REQ_PRIO,		/* 提升 io 优先级 */
	__REQ_NOMERGE,		/* 不允许与其他请求合并 */
	__REQ_IDLE,		/* 预期之后还有更多 IO */
	__REQ_INTEGRITY,	/* IO 中包含数据完整性 payload */
	__REQ_FUA,		/* 强制单元访问 */
	__REQ_PREFLUSH,		/* 强制缓存刷盘 */
	__REQ_RAHEAD,		/* 预先读（可以随时失败） */
	__REQ_BACKGROUND,	/* 后台 IO */
	__REQ_NOWAIT,           /* 遇到阻塞直接返回，用于高并发 */
	__REQ_POLLED,		/* 调用方使用 bio_poll 主动轮询完成 */
	__REQ_ALLOC_CACHE,	/* 可用时从缓存分配 IO */
	__REQ_SWAP,		/* 交换分区 I/O */
	__REQ_DRV,		/* 驱动自用标志 */
	__REQ_FS_PRIVATE,	/* 文件系统自用标志 */
	__REQ_ATOMIC,		/* 原子写入标志 */
	/*
	 * Command specific flags, keep last:
	 */
	/* for REQ_OP_WRITE_ZEROES: */
	__REQ_NOUNMAP,		/* 全 0 不放块 */

	__REQ_NR_BITS,		/* 标志位数量上限 */
};
```

`bio_flags` 有如下几种：

```c
/*
 * bio flags
 */
enum {
	BIO_PAGE_PINNED,	/* 解除在 bio_release_pages() 中固定的页面 */
	                    /* 确保释放 bio 时正确释放页面引用 */
	BIO_CLONED,		/* bio 是克隆的，没有数据，vector 不是自己分配的 */
	                /* 不能主动释放数据 */
	BIO_QUIET,		/* 静默模式，不能主动释放数据 */
	BIO_CHAIN,		/* bio是 链式, bi_remaining 字段生效 */
	BIO_REFFED,		/* bio 已经被引用 ->bi_cnt */
	BIO_BPS_THROTTLED,	/* 已经执行带宽限制，不需要限速 */
	BIO_TRACE_COMPLETION,	/* bio_endio() 应该记录该 bio 的完成 */
	                        /* 用于 trace / 调试 */
	BIO_CGROUP_ACCT,	/* 被计入 cgroup IO 统计 */
	BIO_QOS_THROTTLED,	/* bio 经过了 rq_qos 的限速路径 */
	/*
	 * This bio has completed bps throttling at the single tg granularity,
	 * which is different from BIO_BPS_THROTTLED. When the bio is enqueued
	 * into the sq->queued of the upper tg, or is about to be dispatched,
	 * this flag needs to be cleared. Since blk-throttle and rq_qos are not
	 * on the same hierarchical level, reuse the value.
	 */
	BIO_TG_BPS_THROTTLED = BIO_QOS_THROTTLED,
	BIO_QOS_MERGED,		/* bio 经过了 rq_qos 的合并路径 */
	BIO_REMAPPED,
	BIO_ZONE_WRITE_PLUGGING, /* bio handled through zone write plugging */
	BIO_EMULATES_ZONE_APPEND, /* bio emulates a zone append operation */
	BIO_COMPLETE_IN_TASK, /* complete bi_end_io() in task context */
	BIO_FLAG_LAST
};
```
