---
title: Linux 读写 I/O 调用追踪
date: 2026-11-09
tags: [学习笔记, Linux Kernel, 存储栈, I/O]
# Cover artwork by RIVER (artist): https://wallhaven.cc/w/y8ryxl
thumbnail: /images/covers/linux-io-trace-thumbnail.webp
cover: /images/covers/linux-io-trace.webp
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

这里使用`trace-cmd`工具，追踪指令如下：

```shell
sudo trace-cmd record -o read_demo.dat \
  -p function_graph -g vfs_read \
  -e block:block_bio_queue \
  -e block:block_rq_issue \
  -e block:block_rq_complete \
  -T \
  dd if=./demo_4k.bin of=/dev/null \
     bs=4096 count=1 iflag=direct status=none
```

指令的具体含义为：

- `trace-cmd record`：启用采集；

- `-p function_graph`：生成函数调用图；

- `-g vfs_read`：记录起点为`vfs_read`函数；

- `-e`：后面的格式为`[子系统:事件名称]`，就是直接记录调用的事件；

- `-T`：额外记录当时的事件调用栈。

之后对记录结果进行查看：

```shell
sudo trace-cmd report -i read_demo.dat
```

发现内容过多，于是使用 AI 工具进行了一下过滤：

```cpp
vfs_read() {
  ext4_file_read_iter() {
    iomap_dio_rw() {
      __iomap_dio_rw() {
            iomap_dio_submit_bio() {
              submit_bio() {
                submit_bio_noacct() {
                  submit_bio_noacct_nocheck() {
                    __submit_bio() {
                      blk_mq_submit_bio() {
        blk_finish_plug() {
          __blk_flush_plug() {
            blk_mq_flush_plug_list() {
                blk_mq_run_hw_queue() {
                  blk_mq_sched_dispatch_requests() {
                    __blk_mq_sched_dispatch_requests() {
                        blk_mq_dispatch_rq_list() {
                          scsi_queue_rq() {
                            blk_mq_start_request() {
                            scsi_dispatch_cmd() {
                              ata_scsi_queuecmd() {
                                  ata_scsi_translate() {
                                    ata_qc_issue() {
                                      ahci_qc_prep() {
                                      ahci_qc_issue(); (ret=0x0)
      iomap_dio_complete() {
} (ret=0x1000)
```
