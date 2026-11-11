---
title: MD RAID
date: 2026-11-11
tags: [学习笔记, Linux Kernel, 存储栈, RAID]
# Cover artwork by Ya ju: https://wallhaven.cc/w/9m2mo1
thumbnail: /images/covers/md-raid-thumbnail.webp
cover: /images/covers/md-raid.webp
excerpt: Linux MD 软件 RAID 与 RAID0 条带化存储机制。
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

另外，对于一个 raid0 阵列，`strip_zone`不是唯一的，当阵列下的设备`chunk`数量不一致时，存在多个条带区：

- 设备A、B、C 的 chunks 数量分别为 5、5、3；

- `strip_zone_1`由`A_chunks[:3]`、`B_chunks[:3]`、`C_chunks`构成；

- `strip_zone_2`由`A_chunks[3:]`、`B_chunks[3:]`构成。

### r0layout






