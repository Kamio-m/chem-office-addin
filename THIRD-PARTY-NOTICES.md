# 第三方组件声明

本项目自身以 [MIT 许可证](LICENSE) 发布。以下第三方组件随本项目一同分发，
其版权归各自作者所有，按各自的许可证使用。

打包生成的 `化学工具.exe` 内包含下列组件的代码，分发时请随附本文件与
[`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)。

## 化学结构与绘图

| 组件 | 版本 | 许可证 | 版权 |
| --- | --- | --- | --- |
| [Ketcher](http://lifescience.opensource.epam.com/ketcher)（ketcher-core / ketcher-react / ketcher-standalone） | 3.18.0 | Apache-2.0 | EPAM Life Sciences |
| [Indigo](https://github.com/epam/Indigo)（indigo-ketcher，WASM 版） | 1.46.0 | Apache-2.0 | EPAM Life Sciences |

## 前端框架与构建工具

| 组件 | 许可证 | 版权 |
| --- | --- | --- |
| [React](https://react.dev/) / React DOM | MIT | Meta Platforms, Inc. and affiliates |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | Microsoft Corporation |
| [Vite](https://vite.dev/) | MIT | Evan You and Vite contributors |

## 打包工具（不随产物分发）

| 组件 | 说明 |
| --- | --- |
| [Node.js](https://nodejs.org/)（Node SEA） | MIT，作为单文件 exe 的运行时基底 |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | 用于生成 Windows 安装包；其自身代码不进入本项目的分发产物 |

## 关于 OSRA

图片识别功能**通过网络调用**美国国立癌症研究所（NCI）公开的
[OSRA](https://sourceforge.net/projects/osra/) 在线服务
（OSRA 本身为 GPLv2）。

本项目**不包含、不链接、不分发 OSRA 的任何代码或二进制文件**，
仅以 HTTP 请求的形式使用其在线服务，因此不受 GPL 条款约束。

> ⚠️ 如果你打算把 OSRA 的可执行文件放进本仓库并随项目分发，
> 请先阅读 GPLv2 条款——那会让整个项目的分发方式受到约束。

## 关于 Imago

早期版本曾内置 [Imago](https://lifescience.opensource.epam.com/imago/)（GPLv3）
本地识别引擎，因识别效果不佳已完全移除，当前代码与产物中不含其任何部分。

---

## 许可证全文

- MIT：见 [`LICENSE`](LICENSE)
- Apache-2.0：见 [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)
