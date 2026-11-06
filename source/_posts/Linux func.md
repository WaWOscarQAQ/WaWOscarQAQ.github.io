---
title: Linux 函数
date: 2026-11-06
tags: [学习笔记, Linux Kernel]
# Cover artwork by WaterSnake (artist): https://wallhaven.cc/w/2ygxqx
thumbnail: /images/covers/linux-func-thumbnail.webp
cover: /images/covers/linux-func.webp
excerpt: Linux syscall 常用函数
---

# Linux 函数

## `open()`

`open`命令用于打开文件，使用时需要引用头文件`<fcntl.h>`，若失败，返回-1，否则返回正整数：

- 0是标准输入流；

- 1是标准输出流；

- 2是标准错误流；

- 其他文件从3开始递增。

函数声明如下：

```c
#include<fcntl.h>
int open(const char* pathname, int flags);
int open(const char* pathname, int flags, mode_t mode);
```

该函数是 UNIX 的系统调用函数，不是 C 语言的库函数`fopen`：

- `pathname`是要打开或创建的文件路径;

- `flags`是标记，用来标识要打开或创建的文件所拥有的权限，由主 flags 和备 flags 组成；

- `mode_t`为可选参数，表示用户权限。

**主`flags`参数**

一共有三个，必须选一个：

- `O_RDONLY`：只读模式；

- `O_WRONLY`：只写模式；

- `O_RDWR`：读写模式；

**备用`flags`参数**

以下为常见参数：

- `O_APPEND`：每次写操作都写入文件的末尾；

- `O_CREAT`：如果指定文件不存在，则创建这个文件；

- `O_EXCL`：如果要创建的文件已存在，则返回-1，并且修改`errno`的值；

- `O_TRUNC`：如果文件存在，则清空文件全部内容；

- `O_NOCTTY`：如果路径名指向终端设备，不要把这个设备用作控制终端；

- `O_NONBLOCK`：如果路径名指向FIFO/块文件/字符文件，则把文件的打开和后继I/O
