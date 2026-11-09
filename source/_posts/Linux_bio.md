---
title: Linux 块设备层 IO 请求
date: 2026-11-02
tags: [学习笔记, Linux Kernel, 存储栈]
thumbnail: /images/covers/linux-bio.webp
cover: /images/covers/linux-bio.webp
excerpt: 简单了解通用块层——梳理 struct bio 和 struct request
---

# Linux 通用块层 IO 请求

在用户空间发起读写请求时，如果 page cache 没有需要的数据，需要从存储介质中进行读取/写入。Linux 为了兼容各种各样的存储设备，同样抽象出了通用块层作为统一接口向上层文件系统或页缓存提供高效读写服务。

在块通用块层，Linux 使用 `struct bio`和`struct request`这两种结构体抽象，把上层的IO请求与下层实际能够高效处理 IO 单元进行了完美的解耦和桥接，实现了高性能、高兼容性的通用存储框架：

- 上层文件系统将需求包装成 `struct bio`，表达自己要读写什么地方的多少数据；

- 通用块层在`struct bio`基础上进一步将IO请求处理成 `struct request`结构，并下发给设备驱动处理；

其中，`bio`和`request`之间的关系可以是：

- 多个`bio`合并到一个 `request`；

- 一个`bio`拆解成多个`request`；

通用块层在`submit_bio`到`queue_rq`这段对话中，负责从`bio->request`的调度，极大提升了系统IO性能和硬件利用率

## 1 `struct bio`

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

### 1.1 `bi_opf`

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

### 1.2 `bio_flags`

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

### 1.3 `bio_vec`与`bio_iter`

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

## 2 执行流程 `submit_bio`

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

### 2.1 `submit_bio_noacct`

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

	if (blk_throtl_bio(bio)) //存在限速，会在这里拦截，之后使用 blk-throtl 调度之后提交
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

### 2.2 `submit_bio_noacct_nocheck`

```c
void submit_bio_noacct_nocheck(struct bio *bio, bool split)
{
	if (unlikely(blk_error_inject(bio))) // unlikely() 告诉编译器结果通常为假
		return;                          // 方便编译器优化代码布局

	blk_cgroup_bio_start(bio); // cgroup 的 IO 统计工作

    // bio 是否设置了完成时追踪工作
	if (!bio_flagged(bio, BIO_TRACE_COMPLETION)) {
		trace_block_bio_queue(bio); // bio 入队跟踪
		/*
		 * 既然已经设置入队跟踪, 完成时跟踪也要设置
		 */
		bio_set_flag(bio, BIO_TRACE_COMPLETION);
	}

	/*
	 * 我们希望每个时刻只激活一个 submit_bio 过程, 否则堆叠块设备时会造成栈空间消耗
	 * 这里使用 current->bio_list 记录一个 submit_bio 调用期间被提交的所有 bio
	 * 在 submit_bio 方法回来之后，统一处理这些 bio
	 */
	if (current->bio_list) {
		if (split) // 这次提交是否来自 bio 拆分路径
		           // 所谓的拆分路径, 是指由于设备处理块数原因, 需要将原有 bio 进行拆解
		    // 来自拆分路径，放到头部, 优先处理
			bio_list_add_head(&current->bio_list[0], bio); 
		else
		    // 放到尾部，进行排队
			bio_list_add(&current->bio_list[0], bio);
	// 如果目标没有实现 bd_has_submit_bio
	} else if (!bdev_test_flag(bio->bi_bdev, BD_HAS_SUBMIT_BIO)) {
		__submit_bio_noacct_mq(bio); // 调用 mq （多队列块层）递交函数
	} else {
		__submit_bio_noacct(bio); // 调用设备专用 submit_bio 递交函数
	}
}
	 
```

### 2.3 `__submit_bio_noacct`

```c
static void __submit_bio_noacct(struct bio *bio)
{
    // bio_list_on_stack[0]: 本次提交任务中生成的 bio
    // bio_list_on_stack[1]: 本次任务之前提交但没有处理的 bio
	struct bio_list bio_list_on_stack[2];

	BUG_ON(bio->bi_next); // 这里应该保证 bio->bi_next 为空, 保证 bio 是独立的

	bio_list_init(&bio_list_on_stack[0]); // 初始化 bio_lisk_on_stack[0]
	current->bio_list = bio_list_on_stack; // 绑定当前进程的 bio_list

	do {
	    // 设备的 request queue
		struct request_queue *q = bdev_get_queue(bio->bi_bdev);
		// lower: 指向更底层设备的 bio
		// same: 指向当前设备的 bio
		struct bio_list lower, same;

		/*
		 * 为下层 request 创建一个 bio_list
		 */
		bio_list_on_stack[1] = bio_list_on_stack[0]; // 旧的 0 备份到 1
		bio_list_init(&bio_list_on_stack[0]); // 重新初始化 0

        // 递归提交当前 bio
        // 过程中如果出现新的 bio，挂入 bio_list_on_check[0]
		__submit_bio(bio);

		/*
		 * 遍历本层生成的 bio, 按照目标设备队列
		 * 如果是当前 q, 放入 same
		 * 不是 q, 放入 lower
		 */
		bio_list_init(&lower);
		bio_list_init(&same);
		while ((bio = bio_list_pop(&bio_list_on_stack[0])) != NULL)
			if (q == bdev_get_queue(bio->bi_bdev))
				bio_list_add(&same, bio);
			else
				bio_list_add(&lower, bio);

		/*
		 * 组合提交队列：指向底层 bio 的设备优先, 其次是本设备队列, 最后是上层残留的 bio 队列
		 */
		bio_list_merge(&bio_list_on_stack[0], &lower);
		bio_list_merge(&bio_list_on_stack[0], &same);
		bio_list_merge(&bio_list_on_stack[0], &bio_list_on_stack[1]);
	} while ((bio = bio_list_pop(&bio_list_on_stack[0]))); // 从 bio_list_on_stack[0] 弹出 bio 提交

	current->bio_list = NULL;
}
```

这里比较复杂：

在进入循环之前, `bio`链表中只有一个元素；

1. 使用`bio_list_on_stack[0]`装载这次递归的`bio`，使用`bio_list_on_stack[1]`装载之前未完成的`bio`，当前进程（`current`）绑定`bio_list_on_stack`；

2. 每次使用栈 1备份栈 0，并且提交当前 `bio`，将这次提交多出的 `bio` 存放到栈 0 中；

3. 对新生成的`bio`进行划分：

   - 如果设备调用栈是当前的 `q`，放入`same`；

   - 否则是底层设备，放入`lower`；

4. 进行栈合并：优先级为：`lower` > `same` > `bio_list_on_stack[1]`

上述循环结束之后，从当前`bio_list_on_stack[0]`中`pop`一个新元素，作为 `bio`投入新循环。以下是对具体栈变化的描述：

![](/images/contents/Linux_Kernel/submit_bio_noacct.png)

### 2.4 `submit_bio_noacct_mq`

```c
static void __submit_bio_noacct_mq(struct bio *bio)
{
	struct bio_list bio_list[2] = { };

  /* 取出当前进程的待提交 bio 列表 */
	current->bio_list = bio_list;

	do {
		__submit_bio(bio);
	/* 从列表中取出一个 bio, bio_list [0] 是主 bio 列表 */
	} while ((bio = bio_list_pop(&bio_list[0]))); 

	current->bio_list = NULL;
}
```

在 mq 下不需要递归提交，根本原因是每次加入待处理链表的 bio 属于同一个请求队列，不需要进行下层请求优先的跨层排序。

### 2.5 `__submit_bio`

```c
static void __submit_bio(struct bio *bio)
{
    // 是否实现了自己提交函数
	if (!bdev_test_flag(bio->bi_bdev, BD_HAS_SUBMIT_BIO)) {
		blk_mq_submit_bio(bio); // 现代磁盘驱动基本使用这个函数
	} else if (likely(bio_queue_enter(bio) == 0)) {
	    // md raid zram stacking driver 进入这里
		struct gendisk *disk = bio->bi_bdev->bd_disk; // 找到对应块设备的磁盘
	
        // bio 设置 REQ_POLLED， 通过轮询检查 I/O 完成情况
        // 检查设备是否支持
		if ((bio->bi_opf & REQ_POLLED) &&
		    !(disk->queue->limits.features & BLK_FEAT_POLL))
			bio_endio_status(bio, BLK_STS_NOTSUPP); 
		else
		    // 使用驱动注册的 submit_bio 提交 bio
			disk->fops->submit_bio(bio);
		blk_queue_exit(disk->queue); // 结束之后，blk_queue_exit() 释放队列资源
	}
}
```

## 3 `struct request`

```c
struct request {
	struct request_queue *q; // request 所属的队列，决定要去哪个块设备
	struct blk_mq_ctx *mq_ctx; // 多队列下 request 上下文信息
    						   // 主要识别这个 request 属于哪个 software 队列
    						   // 通常与 CPU 绑定
	struct blk_mq_hw_ctx *mq_hctx; // 多队列下硬件上下文

	blk_opf_t cmd_flags; // 操作码和常用标志，和 bio_opf 功能类似
	req_flags_t rq_flags; // 状态标志

	int tag; // 一个 request 在请求队列中的唯一标识, 用于硬件队列和 IO 调度识别
	int internal_tag; // 内部管理标识，主要用于在 request_pool 中管理

	unsigned int timeout;

	// 内部标识，永远不要外用
	unsigned int __data_len; // request 总长度，单位是字节
	sector_t __sector; // 扇区游标，现在处理到的扇区号

	struct bio *bio; // req 对应的 bio 链表，一个 request 可以对应多个 bio
	struct bio *biotail; // bio 链表列尾

	union {
		struct list_head queuelist; // 双向链表，将 request 加入各种队列中
		struct request *rq_next; // 单向链表，用于 request 合并等场景
	};

	struct block_device *part; // 目标块设备 or 分区
#ifdef CONFIG_BLK_RQ_ALLOC_TIME
	/* Time that the first bio started allocating this request. */
	u64 alloc_time_ns;
#endif
	/* Time that this request was allocated for this IO. */
	u64 start_time_ns; // request 被分配到这个 IO 时间戳
	/* Time that I/O was submitted to the device. */
	u64 io_start_time_ns; // request 被提交到设备的时间戳

#ifdef CONFIG_BLK_WBT
	unsigned short wbt_flags;
#endif
	/*
	 * 用于统计 request 最初的扇区数
	 * 数值与 blk_rq_sectors(rq) 相同, 但是这个值永远不会被清零
	 */
	unsigned short stats_sectors;

	/*
	 * 在物理地址合并（coalescing）之后，scatter-gather DMA 地址 + 长度对的数量。
	 * 设备在 DMA 传输时，数据地址可能分布在不同内存物理页上
	 * Scatter-gather DMA 机制允许一次传输描述多个（物理地址，长度）对，称为 “SG 列表”。
	 * 设备可以一次性高效读写多个不连续的 DMA 片段
	 */
	unsigned short nr_phys_segments;
	unsigned short nr_integrity_segments;

	/*
	 * The lowest set bit for address gaps between physical segments. This
	 * provides information necessary for dma optimization opprotunities,
	 * like for testing if the segments can be coalesced against the
	 * device's iommu granule.
	 */
	unsigned char phys_gap_bit;

#ifdef CONFIG_BLK_INLINE_ENCRYPTION
	struct bio_crypt_ctx *crypt_ctx;
	struct blk_crypto_keyslot *crypt_keyslot;
#endif

	enum mq_rq_state state; // request 状态
	atomic_t ref; // 引用计数，防止被提前释放

	unsigned long deadline; // 调度 deadline，IO scheduler 

	/*
	 * hash 只在调度器中使用, 在 request 进入 dispatch 列表之后就会废除 
	 * ipi_list 用于将 request 加入软中断完成队列
	 * 这发生在 request 已经在 hash 中移除之后
	 */
	union {
		struct hlist_node hash;	/* merge hash */
		struct llist_node ipi_list;
	};

	
 /*
  * rb_node 仅用于 io scheduler 内部，当 request 被移到 dispatch 队列时就会被移除。
  * special_vec 只有在设置了 RQF_SPECIAL_PAYLOAD 时才能使用，而且带有该标志的 request
  * 不能被插入到 IO 调度器中。
  */
	union {
		struct rb_node rb_node;	// 将 request 加入红黑树结构，用于调度排序查找
		struct bio_vec special_vec; // 特殊 payload 时使用
	};

	/*
	 * 预留三个指针给 io_schedular 使用, 如果需要更多需要动态分配使用
	 */
	struct {
		struct io_cq		*icq;
		void			*priv[2];
	} elv;

    // flush 请求相关的数据，保存原本的 end_io 回调和序号
	struct {
		unsigned int		seq;
		rq_end_io_fn		*saved_end_io;
	} flush;

	u64 fifo_time;

	/*
	 * 完成回调
	 */
	rq_end_io_fn *end_io;
	void *end_io_data;
};
```

## 4 request 提交过程

### 4.1 `blk_mq_submit_bio`

这个函数负责创建并把`request`请求发送到对应块设备上。函数会根据`q`和`bio`构建`struct request`结构体。但是符合以下条件的`request`可能不会被直接放入硬件队列中：

- 该`request`可以与其它请求合并；
- 希望把`request`放到`plug`队列，以便未来合并；
- 队列上启用 IO 调度器。

这里有几个概念：

- **plug queue**：`blk_plug`是一个进程私有的临时请求缓冲区，收集短时间内的私有请求，一起发送给设备，提高合并和吞吐效率。注意，进入这个队列的`request`没有进入硬件队列；
- **请求合并**：由程序局部性原理可知，块设备访问容易出现聚焦性。为了把寻址区域相同的请求一同发送给 IO 设备，将这些相近请求合并可以提高 IO 读写效率，降低读写次数；
- **IO scheduler**：硬件挂载了 IO 调度器，就可能被排序、合并之后进入硬件队列；
- **blk_mq**：块设备多队列，支持多核并发，每个 CPU 由各自的硬件队列。
- **zone 写入管理**：负责维持提交顺序，保证提交的写入请求能够按照顺序合理实现。

```c
void blk_mq_submit_bio(struct bio *bio)
{
	struct request_queue *q = bdev_get_queue(bio->bi_bdev);
	struct blk_plug *plug = current->plug;
	const int is_sync = op_is_sync(bio->bi_opf);
	unsigned int integrity_action;
	struct blk_mq_hw_ctx *hctx;
	unsigned int nr_segs; // 当前处理的 bio 所需的物理数据段数量
	struct request *rq; // 用于复用或者新建的 request 指针
	blk_status_t ret;

	// plug->cached_rqs 中可能有缓存请求，尝试取出来一个查看是否有缓存
	rq = blk_mq_get_cached_request(plug, q, bio->bi_opf);


    // 为之前被 zone 写入机制暂存、现在被放行并重新提交的 bio准备的快捷路径
    // 这个 bio 已经实现了检测和拆分，可以被直接送去 request
	if (bio_zone_write_plugging(bio)) {
		nr_segs = bio->__bi_nr_segments;
		if (rq) // 如果缓存里有 rq，就归还一个队列使用引用
			blk_queue_exit(q);
		goto new_request;
	}


    // 拿到缓存 rq，持有队列使用计数，没有拿到时，需要
	if (!rq) {
		if (unlikely(bio_queue_enter(bio)))
			return;
	}

	/*
	 * Device reconfiguration may change logical block size or reduce the
	 * number of poll queues, so the checks for alignment and poll support
	 * have to be done with queue usage counter held.
	 */
    // 检查 bio 是否满足要求，必要时需要拆分
    // 检查起始位置和长度是否满足设备逻辑块大小的对齐要求
	if (unlikely(bio_unaligned(bio, q))) { 
		bio_io_error(bio);
		goto queue_exit;
	}

    // 如果块设备不支持轮询查询，但是 bio 要求支持，就报错不支持
	if ((bio->bi_opf & REQ_POLLED) && !blk_mq_can_poll(q)) {
		bio_endio_status(bio, BLK_STS_NOTSUPP);
		goto queue_exit;
	}

    // 如果超出大小限制就进行 bio 分块
	bio = __bio_split_to_limits(bio, &q->limits, &nr_segs);
	if (!bio) 
		goto queue_exit;

	integrity_action = bio_integrity_action(bio);
	if (integrity_action) // 数据完整性扩展准备
		bio_integrity_prep(bio, integrity_action);

    // 按需记录 bio 的提交时间，供 cgroup I/O 延迟统计和控制使用
	blk_mq_bio_issue_init(q, bio); 
	// 能与已有请求进行合并就合并
	if (blk_mq_attempt_bio_merge(q, bio, nr_segs))
		goto queue_exit;
    // zone 写入管理
	if (bio_needs_zone_write_plugging(bio)) {
	    // 检查实际目标 zone,并实现管理
		if (blk_zone_plug_bio(bio, nr_segs))
			goto queue_exit;
	}
new_request:
    // 缓存中的请求
	if (rq) {
	    // 按照 IO QoS 限流处理请求
		rq_qos_throttle(rq->q, bio);
		// 复制读写类型和相关标志
		rq->cmd_flags = bio->bi_opf;
		// 初始化 list 的链表节点
		INIT_LIST_HEAD(&rq->queuelist);
		// 补齐实际使用时的时间记录、调度器相关状态
		blk_mq_rq_late_init(rq, blk_time_get_ns());
	} else { // 没有缓存中的请求，处理本次请求
	    // 尝试获取新请求，如果失败报错
		rq = blk_mq_get_new_requests(q, plug, bio);
		if (unlikely(!rq)) {
			if (bio->bi_opf & REQ_NOWAIT)
				bio_wouldblock_error(bio);
			goto queue_exit;
		}
	}

    /*
     * 记录追踪信息，将 bio 挂在 request 上
     */
	trace_block_getrq(bio);

	rq_qos_track(q, rq, bio);

	blk_mq_bio_to_request(rq, bio, nr_segs);
    // 准备把资源加密
    // 如果请求需要设备的内联加密能力，
    // 就为它获取或引用相应的密钥槽，供驱动后续使用；
    // 普通请求直接成功。
	ret = blk_crypto_rq_get_keyslot(rq);
	// 如果状态不对，就直接释放请求，释放 bio
	if (ret != BLK_STS_OK) {
		bio_endio_status(bio, ret);
		blk_mq_free_request(rq);
		return;
	}
    // 有 zone 写入要求，进行相关初始化
	if (bio_zone_write_plugging(bio))
		blk_zone_write_plug_init_request(rq);
    // 处理持久化请求
    // blk_insert_flush 按照设备能力安排必要的缓存刷新和数据写入步骤
    // 返回 true 时，说明该请求已经被流程控制结果或完成
	if (op_is_flush(bio->bi_opf) && blk_insert_flush(rq))
		return;

	if (plug) { // 有 plug 队列，就将 rq 先丢进队列中
		blk_add_rq_to_plug(plug, rq);
		return;
	}

    // 在没有 plug 支持下，先选择直接排队
	hctx = rq->mq_hctx; // rq 对应硬件上下文
	// 先排队，再异步触发派发
	// 这里的条件是：请求需要经过 IO 调度器，或者当前派发繁忙，设备只有一个硬件队列
	// 或者 IO 块被判断为非同步类
	if ((rq->rq_flags & RQF_USE_SCHED) ||
	    (hctx->dispatch_busy && (q->nr_hw_queues == 1 || !is_sync))) {
		blk_mq_insert_request(rq, 0);
		blk_mq_run_hw_queue(hctx, true);
	} else { // 其他情况，交给驱动，资源不足时会转入等待队列
		blk_mq_run_dispatch_ops(q, blk_mq_try_issue_directly(hctx, rq));
	}
	return;

queue_exit:
	if (!rq)
		blk_queue_exit(q);
	else
		rq_list_add_head(&plug->cached_rqs, rq);
}
```

对于一个经过内核检测的 `request`请求，首先检查对应块设备有无`plug`队列，如有有就放到队列中。在没有`plug`支持下，根据是否使用 I/O 调度器以及派发是否繁忙，选择先排队并触发派发，或者尝试直接将请求提交给块设备驱动。

### 4.2 `blk_mq_try_issue_directly`

这个函数在尝试将`request`请求直接提交到块设备驱动上：

- 如果设备有足够资源处理这个请求，这个请求就被直接提交到设备上处理；

- 如果设备资源不足，将块设备存放到`hctx->queue`上，在未来某个时刻可以继续尝试发送。在这个队列上的排队请求有着高优先级。

```c
static void blk_mq_try_issue_directly(struct blk_mq_hw_ctx *hctx,
		struct request *rq)
{
	blk_status_t ret;

    // 如果硬件队列暂停或者请求队列暂停派发请求就先放到 queue 中等待下次尝试
	if (blk_mq_hctx_stopped(hctx) || blk_queue_quiesced(rq->q)) {
		blk_mq_insert_request(rq, 0);
		blk_mq_run_hw_queue(hctx, false);
		return;
	}
	
    // 如果请求需要经过 IO 调度器，或者 blk_mq 没有准备好 budget 和 tag
    // 加入 hctx->queue
	if ((rq->rq_flags & RQF_USE_SCHED) || !blk_mq_get_budget_and_tag(rq)) {
		blk_mq_insert_request(rq, 0);
		blk_mq_run_hw_queue(hctx, rq->cmd_flags & REQ_NOWAIT);
		return;
	}

   
	ret = __blk_mq_issue_directly(hctx, rq, true);
	switch (ret) {
	case BLK_STS_OK:
		break;
	// 一般资源不足, 比如 DMA、内存
	case BLK_STS_RESOURCE:
	// 设备特定资源不足
	case BLK_STS_DEV_RESOURCE:
	    // 绕过 I/O 调度器，把 rq 放到 hctx->dispatch 链表的尾部
		blk_mq_request_bypass_insert(rq, 0);
		// 尝试运行队列
		blk_mq_run_hw_queue(hctx, false);
		break;
	default:
		blk_mq_end_request(rq, ret);
		break;
	}
}
```

这里需要注意以下两个队列：

- `hctx->queue`：在调用驱动之前发现不能进行派发，就存入这个队列；

- `hctx->dispatch`：在调用驱动之后发现不能派发，存入的队列。

### 4.3 `__blk_mq_issue_directly`

这个函数是在不考虑失败处理的情况下，对块设备进行直接请求。

```c
static blk_status_t __blk_mq_issue_directly(struct blk_mq_hw_ctx *hctx,
					    struct request *rq, bool last)
{
	struct request_queue *q = rq->q;
	struct blk_mq_queue_data bd = {
		.rq = rq,
		.last = last,
	};
	blk_status_t ret;

	/*
	 * For OK queue, we are done. For error, caller may kill it.
	 * Any other error (busy), just add it to our list as we
	 * previously would have done.
	 */
	ret = q->mq_ops->queue_rq(hctx, &bd);
	switch (ret) {
	case BLK_STS_OK: // 如果 OK，更新设备繁忙程度
		blk_mq_update_dispatch_busy(hctx, false);
		break;
	case BLK_STS_RESOURCE:
	case BLK_STS_DEV_RESOURCE:
		blk_mq_update_dispatch_busy(hctx, true); // 资源紧张
		// 回退 req 状态
		__blk_mq_requeue_request(rq);
		break;
	default:
		blk_mq_update_dispatch_busy(hctx, false);
		break;
	}

	return ret;
}
```

这里在遇到不同的设备返回状态时：

- 首先调用`blk_mq_update_dispatch_busy`更新设备繁忙程度；

- 如果返回值是资源紧张，就调用`__blk_mq_requeue_request`回退请求状态。

值得注意的是，对于`queue_rq`函数，是由具体的驱动实现的，我们这里就先不进一步讨论：

```c
struct blk_mq_ops {
	/**
	 * @queue_rq: Queue a new request from block IO.
	 */
	blk_status_t (*queue_rq)(struct blk_mq_hw_ctx *,
				 const struct blk_mq_queue_data *);
	......
}
```

### 4.4 `blk_mq_run_hw_queue`

这个函数是运行硬件队列的流程：

- 首先，检查 `hctx` 所属的请求队列是否未处于暂停派发状态，并且是否存在等待派发的请求；

- 满足条件就启动该`hctx`对应的派发流程，尝试将请求给驱动，进而提交到硬件。

```c
void blk_mq_run_hw_queue(struct blk_mq_hw_ctx *hctx, bool async)
{
	bool need_run;

	/*
	 * 如果调用者标记允许直接执行，但处于中断过程中
	 */
	WARN_ON_ONCE(!async && in_interrupt());

    // 标注后续可能睡眠的情况
    // 如果支持直接执行，并且硬件上下文有后续可能面临 blk_mq 派发请求有被阻塞的情况
	might_sleep_if(!async && hctx->flags & BLK_MQ_F_BLOCKING);

    // 检查请求队列是否停止派发，hctx 是否有等待派发的请求
	need_run = blk_mq_hw_queue_need_run(hctx);
	if (!need_run) {
		unsigned long flags;
        // 第一次认为不需要的时候，加锁再确认
        // 加锁的作用是篇：为了防止在检查过程中其他 cpu 并发执行接触暂停的情况
		spin_lock_irqsave(&hctx->queue->queue_lock, flags);
		need_run = blk_mq_hw_queue_need_run(hctx);
		spin_unlock_irqrestore(&hctx->queue->queue_lock, flags);

		if (!need_run)
			return;
	}
    // 这里两种情况：
    // 异步执行
    // hctx 的 cpumask 没有当前 CPU 
    // 将这个请求交给工作队列，异步执行
	if (async || !cpumask_test_cpu(raw_smp_processor_id(), hctx->cpumask)) {
		blk_mq_delay_run_hw_queue(hctx, 0);
		return;
	}

    // 上下文执行派发入口
	blk_mq_run_dispatch_ops(hctx->queue,
				blk_mq_sched_dispatch_requests(hctx));
}
EXPORT_SYMBOL(blk_mq_run_hw_queue);
```

## 5 `plug` 队列流程

### 5.1 初始化`plug`

`plug`队列在`submit_bio`之前，其中初始化函数为`blk_start_plug`，被`__iomap_dio_rw`调用，一个函数调用的上下文路径为：

> `__iomap_dio_rw`负责组织一次文件的 Direct I/O：把文件范围和用户缓冲区转换成 bio 提交，并管理等待、错误和完成状态。

```c
vfs_read()
  → ext4_file_read_iter()
    → iomap_dio_rw()
      → __iomap_dio_rw()
```

其中具体函数很简单：

```c
void blk_start_plug(struct blk_plug *plug)
{
	blk_start_plug_nr_ios(plug, 1);
}
EXPORT_SYMBOL(blk_start_plug);
```

其中`blk_start_plug_nr_ios()`为：

```c
void blk_start_plug_nr_ios(struct blk_plug *plug, unsigned short nr_ios)
{
	struct task_struct *tsk = current;

	/*
	 * If this is a nested plug, don't actually assign it.
	 */
	if (tsk->plug)
		return;

	plug->cur_ktime = 0;
	rq_list_init(&plug->mq_list);
	rq_list_init(&plug->cached_rqs);
	plug->nr_ios = min_t(unsigned short, nr_ios, BLK_MAX_REQUEST_COUNT);
	plug->rq_count = 0;
	plug->multiple_queues = false;
	plug->has_elevator = false;
	INIT_LIST_HEAD(&plug->cb_list);

	/*
	 * Store ordering should not be needed here, since a potential
	 * preempt will imply a full memory barrier
	 */
	tsk->plug = plug;
}
```

这里的核心机制为：`current`为当前线程的`struct task`，如果当前`tsk`有`plug`，不需要准备，如果没有，就初始化一个`plug`，之后挂载到`tsk`上。根据上述代码，我们可以得出结论：一个线程对应一个`plug`。

### 5.2 `blk_add_rq_to_plug`

函数主要负责将对应的`request`放到`plug`队列中，在`blk_mq_submit_bio`中调用。

```c
static void blk_add_rq_to_plug(struct blk_plug *plug, struct request *rq)
{
    // 查看链表中的一个请求
	struct request *last = rq_list_peek(&plug->mq_list);
    // 没有缓存请求，记录 rq 事件
	if (!plug->rq_count) {
		trace_block_plug(rq->q);
	} else if (plug->rq_count >= blk_plug_max_rq_count(plug) ||
		   (!blk_queue_nomerges(rq->q) &&
		    blk_rq_bytes(last) >= BLK_PLUG_FLUSH_SIZE)) {
		// 如果 rq_count 比最大值大
        // 或队列未禁止合并，且已有头部请求大小达到提前刷新阈值
		blk_mq_flush_plug_list(plug, false);
		last = NULL;
		trace_block_plug(rq->q);
	}

    // 如果所有当前没有设置多队列支持
    // 而且最后一个队列的请求和当前队列请求不同
	if (!plug->multiple_queues && last && last->q != rq->q)
		plug->multiple_queues = true;
    // plug还没标记包含使用调度器标签的请求
    // 当前rq正好使用了调度器标签，就把这个情况记下来
	if (!plug->has_elevator && (rq->rq_flags & RQF_SCHED_TAGS))
		plug->has_elevator = true;
	// 将最后的 plug 加入到 mq_list 队尾
	rq_list_add_tail(&plug->mq_list, rq); 
	plug->rq_count++; // 添加队列数
}
```

### 5.3 `blk_finish_plug`

这个函数作为一个 wrapper，在外层调用，首先确认 `plug`是否为当前`plug`，之后在内部调用`__blk_flush_plug`函数，并且将`current->plug`置空。

```c
void blk_finish_plug(struct blk_plug *plug)
{
	if (plug == current->plug) {
		__blk_flush_plug(plug, false);
		current->plug = NULL;
	}
}
EXPORT_SYMBOL(blk_finish_plug);
```

### 5.4 `__blk_flush_plug`

本函数为清理`plug`的真正函数：

```c
void __blk_flush_plug(struct blk_plug *plug, bool from_schedule)
{
    // 如果注册 flush 回调，就执行这些回调
	if (!list_empty(&plug->cb_list)) 
		flush_plug_callbacks(plug, from_schedule);
	/* 将 mq_list 中暂存的 request 交给后续派发流程 */
	blk_mq_flush_plug_list(plug, from_schedule);
	/*
	 * 无论本次刷新由什么原因触发，都清理剩余的备用 request，
	 * 即使本次 unplug 是由任务调度触发的。
	 * 这些备用 request 持有请求队列的引用。
	 * 我们不希望已经阻塞的任务继续持有这些引用，
	 * 从而妨碍队列的冻结或暂停派发操作。
	 */
	if (unlikely(!rq_list_empty(&plug->cached_rqs)))
		blk_mq_free_plug_rqs(plug);

	plug->cur_ktime = 0;
	/* 清除当前任务的块层缓存时间戳标记 */
	current->flags &= ~PF_BLOCK_TS;
}
```
