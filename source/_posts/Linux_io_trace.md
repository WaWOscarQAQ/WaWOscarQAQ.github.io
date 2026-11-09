---
title: Linux 块设备层 IO 请求
date: 2026-11-09
tags: [学习笔记, Linux Kernel, 存储栈, I/O]
thumbnail: /images/covers/linux-bio.webp
cover: /images/covers/linux-bio.webp
excerpt: 通过 trace-cmd 工具和 bdftrace, 进行读写I/O追踪
---

# 读与写的调用追踪

这里我们利用 `trace-cmd`和`bpftrace`尝试读取一次请求的全部过程和详细内容。

## 1 预先准备

首先准备一个大小为 4KB 的文件：

```shell
dd if=/dev/urandom of=./demo_4k.bin \
   bs=4096 count=1 conv=fsync status=none
```

指令的意思是：

- `dd`：命令名称，用于读取、转换并输出数据；

  > dd 可从标准输入或文件中读取数据，根据指定的格式转换数据，再输出到文件、设备或标准输出。

- `if`、`of`：从哪里获取输入、向哪里输出；

- `bs`：同时设置读入/输出的块大小（字节）；

- `count`：多少个块；

- `conv=fsync`：退出之前同步文件的元数据和数据；

由于在进行`fsync`之后文件信息可能残留于页缓存中，所以保留标志`iflag=direct`用于直接观察：

```shell
dd if=./demo_4k.bin of=/dev/null \
   bs=4096 count=1 iflag=direct status=none
```

进行配置检查：

```shell
stat -c 'size：%s bytes；blocks：%b ' ./demo_4k.bin
[output]
size：4096 bytes；blocks：8 
```

## 2 `read()`函数调用栈
