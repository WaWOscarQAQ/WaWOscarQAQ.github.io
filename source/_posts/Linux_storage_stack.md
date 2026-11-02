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

### 1.1 `struct bio`

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

![](/images/contents/Linux_Kernel/bio_struct.png)

#### 1.1.1 `bi_opf`

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

#### 1.1.2 `bio_flags`

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

#### 1.1.3 `bio_vec`与`bio_iter`

`bio_vec`和`bio_iter`分工明确：

- `bio_vec`一个是对应 IO 请求的具体内存块；
- `bio_iter`是请求的具体情况；

其中`bvec_iter`内容如下：

```c
struct bvec_iter {
	/*
	 * Current device address in 512 byte sectors. Only updated by the bio
	 * iter wrappers and not the bvec iterator helpers themselves.
	 */
	sector_t		bi_sector; // 现在正在处理的 bio 处于的分区

	/*
	 * Remaining size in bytes.
	 */
	unsigned int		bi_size; // 还剩多少字节没有处理

	/*
	 * Current index into the bvec array. This indexes into `bi_io_vec` when
	 * iterating a bvec array that is part of a `bio`.
	 */
	unsigned int		bi_idx; // 目前处理到多少 bio_vec

	/*
	 * Current offset in the bvec entry pointed to by `bi_idx`.
	 */
	unsigned int		bi_offset; // 现在处理的 bio_vec 的 offset
} __packed __aligned(4);
```

`bio_vec`如下：

```c
struct bio_vec {
	struct page	*bv_page; // 指向该地址区间的第一个内存页
	unsigned int	bv_len; // 大小
	unsigned int	bv_offset; // 开始位置
};
```

### 1.2 执行流程 `submit_bio`

函数的功能是：将一个 bio IO 请求提交到对应的块设备上。这个函数首先完全初始化了`struct bio`结构体。这个结构体之后会被提交到被`bi_bdev`描述的指定设备上。本次请求的成功 / 失败状态，以及完成的通知，都会通过 `bio->bi_end_io ()` 回调函数以异步方式传递，在 `bi_end_io ()` 被调用之前，调用者【不得】修改或访问该 `bio`。

```c
void submit_bio(struct bio *bio)
{
	if (bio_op(bio) == REQ_OP_READ) { // 从设备中读取 IO
		task_io_account_read(bio->bi_iter.bi_size); // 记录当前任务的读取字节数
		count_vm_events(PGPGIN, bio_sectors(bio)); // 给指定的内核项加一定数值
	} else if (bio_op(bio) == REQ_OP_WRITE) { // 向扇区内写
		count_vm_events(PGPGOUT, bio_sectors(bio));
	}

	bio_set_ioprio(bio); // 确定 bio 的 IO 优先级
	submit_bio_noacct(bio);
}
EXPORT_SYMBOL(submit_bio);
```

其中：

- `task_io_account_read`记录系统读取或写入的扇区数，`PGPGIN`表示读取，`PGPGOUT`表示写入；
- `task_io_account_read`表示在这次任务内读取的字节数，在启用`CONFIG_TASK_IO_ACCOUNTING`时生效。

#### 1.2.1 `submit_bio_noacct`

这个函数主要实现提交 `bio` 请求的细节，同时不再统计相关参数。它是更底层的提交请求，只能被 stacking block drivers 用于将 IO 操作交给更底层的驱动。对于用户和文件系统，应该使用`submit_bio` 。

在这个函数中，主要对 bio 请求的细节进行检查（`REQ_XXX`），之后交给更底层的函数进行处理。

```c
void submit_bio_noacct(struct bio *bio)
{
    // 获取 bio 对应的 bi_bdev 设备
	struct block_device *bdev = bio->bi_bdev;
	struct request_queue *q = bdev_get_queue(bdev); // 查询设备对应的请求队列对象
	blk_status_t status = BLK_STS_IOERR;

	might_sleep();

	// 这里首先检查是否支持不等待直接报错的选项 (遇到阻塞直接返回)
    // 不支持直接返回 not_support 报错
	if ((bio->bi_opf & REQ_NOWAIT) && !bdev_nowait(bdev))
		goto not_supported;

    // 有加密上下文时，检查是否有数据，没有数据以IO错误结束
    // 再监测块设备是否支持 bio 不支持就进行报错
	if (bio_has_crypt_ctx(bio)) { 
		if (WARN_ON_ONCE(!bio_has_data(bio)))
			goto end_io;
		if (!blk_crypto_supported(bio))
			goto not_supported;
	}

    // 一些会出错的情形检查
	if (should_fail_bio(bio))
		goto end_io;
    // 检查是否在写一个只读设备
	bio_check_ro(bio);
    // 检查 IO 是否越界，即是否越过当前块设备
	if (!bio_flagged(bio, BIO_REMAPPED)) {
		if (unlikely(bio_check_eod(bio)))
			goto end_io;
		if (bdev_is_partition(bdev) &&
		    unlikely(blk_partition_remap(bio)))
			goto end_io;
	}

	/*
	 * Filter flush bio's early so that bio based drivers without flush
	 * support don't have to worry about them.
	 */
    // 提前过滤 flush 请求
    // 就是将易失性的缓存进行持久化保存，防止断电消失
	if (op_is_flush(bio->bi_opf)) {
		if (WARN_ON_ONCE(bio_op(bio) != REQ_OP_WRITE &&
				 bio_op(bio) != REQ_OP_ZONE_APPEND))
			goto end_io;
		if (!bdev_write_cache(bdev)) {
			bio->bi_opf &= ~(REQ_PREFLUSH | REQ_FUA);
			if (!bio_sectors(bio)) {
				status = BLK_STS_OK;
				goto end_io;
			}
		}
	}

	switch (bio_op(bio)) {
	case REQ_OP_READ:
		break;
	case REQ_OP_WRITE:
		if (bio->bi_opf & REQ_ATOMIC) {
			status = blk_validate_atomic_write_op_size(q, bio);
			if (status != BLK_STS_OK)
				goto end_io;
		}
		break;
	case REQ_OP_FLUSH:
		/*
		 * REQ_OP_FLUSH 不是通过 bio 提交的, 只能在 struct request 中
		 * 使用 flush 状态机合成。
		 */
		goto not_supported;
	case REQ_OP_DISCARD:
		if (!bdev_max_discard_sectors(bdev))
			goto not_supported;
		break;
	case REQ_OP_SECURE_ERASE:
		if (!bdev_max_secure_erase_sectors(bdev))
			goto not_supported;
		break;
	case REQ_OP_ZONE_APPEND:
		status = blk_check_zone_append(q, bio);
		if (status != BLK_STS_OK)
			goto end_io;
		break;
	case REQ_OP_WRITE_ZEROES:
		if (!q->limits.max_write_zeroes_sectors)
			goto not_supported;
		break;
	case REQ_OP_ZONE_OPEN:
	case REQ_OP_ZONE_CLOSE:
	case REQ_OP_ZONE_RESET:
	case REQ_OP_ZONE_FINISH:
		/* Zone management operations require sequential zones. */
		if (!bdev_zone_is_seq(bio->bi_bdev, bio->bi_iter.bi_sector))
			goto end_io;
		break;
	case REQ_OP_ZONE_RESET_ALL:
		if (!bdev_is_zoned(bio->bi_bdev))
			goto not_supported;
		break;
	case REQ_OP_DRV_IN:
	case REQ_OP_DRV_OUT:
		/*
		 * Driver private operations are only used with passthrough
		 * requests.
		 */
		fallthrough;
	default:
		goto not_supported;
	}

	if (blk_throtl_bio(bio))
		return;
	submit_bio_noacct_nocheck(bio, false); // 更底层的封装
	return;

not_supported:
	status = BLK_STS_NOTSUPP;
end_io:
	bio_endio_status(bio, status);
}
EXPORT_SYMBOL(submit_bio_noacct);
```



