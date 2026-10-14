# RK R87 Pro AI 键盘 HID 协议（逆向自官方 RK-AI 1.0.2）

来源：`%LOCALAPPDATA%\Programs\RK-AI\resources\app.asar` 内 `background.js`（Electron，代码明文）。
逆向产物（hid_core / hid_section / key_logic / frame 的 .pretty.js）存于开发者本地项目外目录，不入仓库。

## 1. 设备识别

- 官方软件枚举所有 HID 设备，只处理 **usagePage ≥ 0xFF00（厂商自定义页）** 的接口。
- R87 Pro AI 对应两条记录（还有全家族 40+ 设备，见 hid_section.pretty.js `loadSupportDevice()`）：
  - 有线 USB：VID `0x248A` / PID `0x8102`，hidType = `R87ProAIB`(1010)，connectWay 1
  - 蓝牙 BLE：VID `0x248A` / PID `0x8243`，hidType = `R87ProAIB`，connectWay 2
- **2.4G 接收器**：插 USB 后键盘同样枚举为 `PID 0x8243`（与蓝牙同 PID，无独立表项）。官方靠
  `isBluetoothConnect(release, interface) = (release==1 || interface==-1)` 区分：真蓝牙（Windows 上
  interface=-1）把 connectWay 从 2 降为 0；USB 上的 8243（interface>=0 且 release!=1）保持 2 = 2.4G dongle。
- 打开方式：`new HID(path)` 直接按 path 打开（Windows 允许多进程共享读取，可与官方软件共存监听）。
- 读写缓冲：62/64 字节；**macOS 上官方写帧强制补满 64 字节**（`EncodeHid_Normal` darwin 分支）。

## 2. 报文帧格式

`DecodeHid_Normal`（AI 键盘用）——两种通道前缀，其余一致：

```
通道0:  [0x05, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
通道1:  [0x05, 0xFF, 0xF1, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
通道2:  [0x05, 0xFF, 0xF0, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
```

- 首字节是 reportId（0x05）；0xC0 是命令魔数；尾部 0xEF 校验。
- 读侧（键盘→主机）：通道1 (0xF1) 蓝牙、通道2 (0xF0) 2.4G/dongle。
- 写侧（主机→键盘，`EncodeHid_Normal(cmd, channel, ...)`）：**channel 0/1 → 前缀 0xF1，channel 2 → 前缀 0xF0**。
  对应实际场景：真蓝牙（connectWay 降为 0）写 0xF1；2.4G dongle（USB 上的 8243，connectWay=2）写 0xF0。

`DecodeHid_RK`（MK87/R87 传统键盘用，reportId 0x01）：

```
[0x01, 0xFA, 0xF2, 0xFE, 0xC1, cmd, len, data[len]..., 0xEF]
```

音频流（不需要处理，语音功能用）：reportId 0x1A(26)/0x1B(27)/0x1C(28)，以及 `[0x05, 0xAD, ...]` 的 SBC 帧。

## 3. 命令字（cmd）

| cmd | 含义 |
|---|---|
| 159 (0x9F) | **按键事件**，dataLen=1，data[0]=键码 |
| 26/27/28 | 麦克风音频流（S7B/SBC/Raw） |

## 4. 键码表（onHidKey_Keyboard + 两轮实机标定确认）

最终物理键位对应（AI 模式下，两轮标定结果 100% 一致）：

| 物理键 | 按下 | 抬起 | 官方功能 (aiMode) |
|---|---|---|---|
| AI 键 | 51 | 66 | AI问答 (1) |
| F1 | 82 | 97 | 文字校对 (8) |
| F2 | 58 | 73 | 阅读 (9) |
| F3 | 55 | 70 | 写作 (6) |
| F4 | 63 | 78 | 长文写作 (13) |
| F5 | 60 | 75 | 心得体会 (10) |
| F6 | 59 | 74 | PPT (2) |
| F7 | 53 | 68 | 绘图 (4) |
| F8 | 54 | 69 | 表格 (5) |
| F9 | 83 | 98 | 项目方案 (16) |
| F10 | 48 | 57 | 语音打字（走语音通道） |
| F11 | 49 | 64 | 翻译/同声传译（走语音通道） |
| F12 | 50 | 65 | 截图 |
| PrtSc | 56 | 71 | 思维导图 (7) |

未在本机出现的协议键码（保留）：80=上网(3)、61=工作总结(11)、62=模板(12)、81=通用短文写作(14)。

官方 16 个 AI 模式全表（渲染进程 chatShortCutListForKeyBoard 逆向）：
1=AI问答 2=PPT 3=上网 4=绘图 5=表格 6=写作 7=思维导图 8=文字校对 9=阅读 10=心得体会 11=工作总结 12=模板 13=长文写作 14=通用短文写作 16=项目方案

其他实测发现：
- **AI 切换键**发独立命令 cmd=209(0xD1)，data 1/0（按下期间重复多帧）
- 按键报文期间键盘伴随发 cmd=106/107 的状态流，忽略即可
- cmd=104(0x68) 是周期心跳（约每 2~3 秒一对，data=0）
- F10/F11 的抬起码会连发两帧（57/64 ×2），边沿触发逻辑天然免疫
- 语音类键（F10/F11/AI键长按）按下后键盘开始经 cmd 26/27/28 流式发麦克风音频

## 5. 写命令（V1 暂不需要）

`EncodeHid_Normal`：`[0x05, 0xFF, (0xF1|0xF0), 0xFE, 0xC0, cmd, len, data..., 0xEF]`。
官方用途：开启/关闭麦克风录音流（openDeviceRecord/closeDeviceRecord）、改键（noticeHid_SetKeyValue）、DPI、固件 OTA 等。将来做"自己接麦克风语音"或"改键"时再深挖。

## 6. 物理键位 ↔ 键码对应（待实测确认）

AI 模式下 F1~F12 + PrtSc 共 13 个键对应上述 11 个 AI 键码 + 语音键码，具体哪个键发哪个码需要实机按键验证（tools/listen.js）。

## 7. 麦克风完整协议（V2 逆向，全部实测验证）

### 7.1 双接口架构（关键！）

键盘同时暴露两个厂商接口（usagePage 0xFF12），**职责不同**：

| 接口 | PID | 角色 | 读写 |
|------|-----|------|------|
| USB 口（MI_01 Col02） | `0x8102` | **完整命令通道** + 按键/音频/状态（写前缀 0xF1） | 读写（2026-08-24 实测推翻下述旧结论） |
| 蓝牙 BLE（Col02） | `0x8243` | **命令通道**（心跳/验证/开麦，写前缀 0xF1） | 读写（写帧 62 字节） |
| 2.4G 接收器（USB，枚举 8243 时） | `0x8243` | 单口双职责（按键+音频+命令，写前缀 0xF0） | 读写 |

> **⚠️ 勘误（2026-08-24 实机标定）**：早期结论「有线口固件零回应、命令必须走蓝牙」**不成立**。
> 当时穷尽的写法只覆盖了 F0/dongle 通道前缀；实测 8102 口对 `05 FF F1 FE C0 ...`（蓝牙同款
> F1 通道）全帧响应：心跳→104、验证→227、开麦→106 全通，完整会话可建立。另注意：2.4G 接收器
> 实测枚举为 **PID 0x8102**（非本表原记的 8243），与线缆连接无法从协议层区分，统一按 USB 口处理。
> USB 音频流为 reportId **0x1C** 的 64B 帧：`[1C][seq:u8][2B][30×int16LE PCM]`，~550 帧/s ≈
> 16kHz 连续采样，**净荷是原始 PCM 无需 SBC 解码**（SBC 解码器虽不报错但输出纯噪声，已用
> 相邻样本相关性 r≈0.96 + 帧率×样本数=16kHz 双重验证）。蓝牙音频仍为 0x1B/62B SBC 帧。

2.4G 模式（枚举 8243 时）USB 上只有一个 8243：命令会话独占该口，按键/音频从
会话读循环转发（kb-session.js 已实现多口轮询：USB dongle 优先，8 秒握手无回应自动换蓝牙口）。
8102 口的会话支持见 kb-session.js（候选含 USB_PID，transport='USB'）。

### 7.2 会话握手（tools/session6.js 验证）

官方软件靠这套握手让键盘进入"可命令"状态，我们完全复刻（kb-session.js）：

```
主机 → 键盘  cmd=5   心跳（open 后立即发一次，之后每秒）
键盘 → 主机  cmd=104 心跳回应
（首次 104）主机 → 键盘  cmd=12  设备状态查询
            主机 → 键盘  cmd=15  验证挑战：32B 随机数（官方算法：
                                 主机自己生成随机数 e，secretKey 本地留存）
键盘 → 主机  cmd=227 验证回应（兼设备型号上报：尾部字节 238=R87ProAIB）
            主机 → 键盘  cmd=17  SN 查询
键盘 → 主机  cmd=177 SN 回应（如 "123162373165..."）
            主机 → 键盘  cmd=1   Open（会话激活）
→ 之后每秒 cmd=5 保活；断线（3 次无 104）重走全流程
```

验证挑战参考实现（逆向自 noticeHid_VerifyDevice，实发随机数本体）：

```js
const e = Array.from({length: 32}, () => Math.floor(Math.random() * 256));
// 主机本地算 secretKey（与键盘侧相同的算法，供后续会话用）：
//   t=(e[7]+2)%32; r=(e[17]+2)%32>2 ? (e[8]+2)%32 : 3; r<2&&(r=3);
//   n=t%r; i=e[23]%32%7;
//   secretKey[k] = "MiMouse".charCodeAt((i+k)%7) ^ e[(n+k)%32]
// 实测：只发 e 本体键盘即接受（227 返回），secretKey 未被校验使用
```

### 7.3 麦克风控制命令

| 命令 | 方向 | 含义 |
|------|------|------|
| `cmd=3` | 主机→键盘 | AskVoice 开麦 → 键盘回 `cmd=106` 并开始推音频流 |
| `cmd=4` | 主机→键盘 | StopVoice 关麦 → 键盘回 `cmd=107`，流停 |
| `cmd=159` | 键盘→主机 | 物理按键上报（data[0]=键码，F10 down=48/up=57） |
| `cmd=106/107` | 键盘→主机 | 麦克风开/关状态通知 |

物理 F10 与软件 AskVoice 双路皆可开麦（V2 采用：F10 按下→主机发 cmd=3，
软件 UI「开始说话」按钮→同样 cmd=3）。

**固件下载引导（鸡贼设计，2026-08-24 实锤）**：固件内烧录字符串
`www.rkgaming.com/download/1/`（见 §9.2 Telink 固件静态分析）。物理语音键
按下后固件自开麦并等待主机 cmd=3 应答；等不到（判定主机无官方软件）就自己
注入标准键盘报文「Win+R → 输入下载网址 → 回车」引流装官方软件。
该序列走标准键盘接口直进系统，用户态软件拦不住——唯一防御是让固件及时
看到 cmd=3。kb-session 的对策：收到 cmd=106 且非主机发起（固件自开麦边沿）
时立即补发 cmd=3（`ask-voice-late`），覆盖普通模式无 cmd=159 上报、厂商码
丢帧、会话瞬断恢复窗三类盲区。app 完全未运行时仍会触发，无软件解法。

### 7.4 音频流格式（V1 已破解，此处归档）

- 报文：reportId `0x1B`，62 字节 = `[0x1B, seq, ...60B 净荷]`，15.0ms/包
- 净荷 = 3 小帧，每帧 `[0xAD, 0x31, 0x0C, ...20B]`
- 编码：厂商私有（**非标准 SBC**——libsbc 全参数穷举失败、CRC 0% 通过；
  亦非 ADPCM/G.711）。解码器 = 官方 npm 包 `mi-sbc`（NAPI v4 全平台
  prebuilds，已 vendor 到 `vendor/mi-sbc/`），`decode(23B帧, 23, 160B dst)`
  恒返回 80 样本 int16
- 每报文 3×80=240 样本 = **16kHz 单声道**，码率约 32kbps
- 后处理（src/main/mic.js）：120Hz 一阶高通 → AGC（目标 RMS 4500，增益
  1~8）→ 噪声门。源头 32kbps 有损，音质上限不可恢复，只能拉响度

### 7.5 两条链路的实测采样率对比（2026-10 补充）

| 链路 | 帧格式 | 帧率 × 每帧样本 | 实测采样率 | 是否需要修正 |
|---|---|---|---|---|
| 蓝牙 | `0x1B` SBC | 66.7 包/秒 × 240 | **16004 Hz**（自动校准值） | 否，标准 16k |
| 2.4G 接收器 | `0x1C` 裸 PCM | 571 帧/秒 × 30 | **17129 Hz**（30s 墙上时钟法：17132 帧/30.00s） | **是，需重采样到 16k** |

**2.4G/有线链路的 17129 Hz 是非标准速率**（标准应为 16000）。这个偏差意味着
固件在打包音频时做了一次重采样（30 样本/帧 × 571 帧/秒 ≠ 16000），
而这一步的质量不可控——**这是蓝牙听感明显更好的可能原因**。

早期文档称「帧率×样本数=16kHz 已验证」，该结论有误：当时未对墙上时钟，
是拿代码自身的假设验证自身的假设（循环论证）。可靠判据只有
**样本数 ÷ 墙上秒数**。程序现按此自动校准（见 `src/main/mic.js` 的
`_autoCalibrate`），两条链路都能正确识别。

### 7.6 虚拟麦克风桥接（V2 完整链路）

```
键盘 --HID 0x1B流--> kb-session(audio) --> mic.js 解码+增强(120ms批)
    --> IPC --> renderer WebAudio(AudioContext 16kHz, sinkId=CABLE Input)
    --> VB-Cable 内部路由 --> 系统「CABLE Output」输入设备
    --> 微信输入法（跟随系统默认麦克风）→ 出字
```

依赖：VB-Cable 虚拟声卡（用户自装）；系统默认输入设备需选 CABLE Output。

### 7.7 官方库 vendor 说明

- `vendor/mi-hid/`：官方 HID 库 fork（hidapi 系）。**必须用它驱动蓝牙口**——
  node-hid 写蓝牙口同样成功但实测键盘不回（原因未深究，可能与其内部
  output report 长度处理有关；mi-hid 实测稳定）
- `vendor/mi-sbc/`：官方音频解码器（全平台 prebuilds）

## 8. 灯效控制（V3 逆向结论：R87 Pro AI 无软件灯效协议）

### 8.1 结论

官方 RK-AI 1.0.2 **没有 R87 Pro AI（hidType 1010）的灯效控制命令**。整个软件里唯一的灯效功能属于
传统 MK87 / RK R87 键盘（hidType 30/31，VID 0x0C45、PID 0x7101/0x7102，即"RK R87"非 AI 版），
走的是与本项目 KeySession 完全不同的传统协议栈。这把 AI 键盘的灯效由固件自理（Fn 组合键调节），
官方软件不做软件侧控制。判定证据链（三处独立交叉验证）：

1. **主进程设备分发**（`hid_section.pretty.js` `deviceProcess`）：`x(hidType)` 只对 MK87(30)/R87(31)
   为真 → 设备进 `CMk87Reader`（`m_listMk87`，灯效命令的唯一宿主）；R87ProAIB(1010) 判假 → 进 AI
   类 `Xe`（`hid_core.pretty.js:3104`，series 2）。`Xe` 除继承基类外只新增一个
   `onPadKeyWorkModeSwitch`（cmd 209 普通模式切换），无任何灯效方法。
2. **AI 协议层命令全景**（基类 `Ze`，`hid_core.pretty.js:2370~2433`，即 noticeHid_* 全部发送点）：
   1 Open / 2 Exit / 3·4 麦克风 / 5 心跳 / 6 DPI / 8·9·10·11 固件 OTA / 12·13 设备·接收器状态 /
   15 验证 / 17 SN / 22 回报率 / 24 改键 / 25 恢复默认——**无灯效命令**。全部 IPC 通道
   （`key_logic.pretty.js` ipcMain.on 清单）里灯效相关的也只有 `mk87SetLightMode` 一个，
   其实现只遍历 `m_listMk87`（AI 键盘不在其中）。
3. **渲染层 UI 门控**：唯一灯效界面（`LightEffect` 组件，「灯效设置」tab）挂在 DeviceDetail 页，
   组件按 `device.type` 分发：type 1/2/3（Mouse/Keyboard/LaserPen）→ DeviceDetail_Normal（DPI、
   回报率、AI 键设置，无灯效）；type 4（MK87，即 `m_mk87Device` 列表）→ 带 LightEffect 的
   DeviceDetail。R87ProAIB 的 type=2（`hid_section.pretty.js:1236` 设备类型函数）→ 无灯效入口。

### 8.2 传统 MK87 灯效协议（附带产物，仅存档参考）

> 以下属于 MK87 / RK R87（非 AI 版）的协议栈，帧格式与本项目 KeySession（05 FF Fx 帧）不兼容，
> 仅为将来可能遇到传统 R87 设备时留档。

- 设备：VID `0x0C45` / PID `0x7101`(MK87)、`0x7102`(RK R87)；处理类 `CMk87Reader`。
- 写帧 `EncodeMk87`（`frame.pretty.js`，reportId 0x06，定长 lenWrite）：

  ```
  [0x06, 0xFE, 0xC0, cmd, param, waitAck(0/1),
   msgID_lo, msgID_hi, blockCnt, blockIdx_lo, blockIdx_hi, dataLen, data[dataLen]..., 0xEF]
  ```

- 读帧 `DecodeHid_RK`（reportId 0x01）：`[0x01, 0xFA, 0xF2, 0xFE, 0xC1, cmd, len, data..., 0xEF]`。
- 灯效命令（`hid_section.pretty.js` `UI_SetLightMode` / `OnProcMk87_LightMode`，连接初始化时
  `SendToMk87_1(101,0)` 查询一次）：
  - **查询当前灯效：cmd=101，param=0**
  - **设置灯效：cmd=102，param=模式值（1~12），无 data**
  - 键盘回应（cmd 101 或 102）：**模式值在 param 字段**，data[0]=单色模式当前颜色下标
    （只读状态，软件不下发颜色）
- 模式表（渲染层 `LightEffect` 组件逆向，设置值即 param）：

  | 值 | 官方名称 | 备注 |
  |---|---|---|
  | 1 | 关闭灯光 (Light_Close) | |
  | 2 | 多色呼吸 (LightMode_02) | |
  | 3 | 单色长亮 (LightMode_03) | 颜色由键盘 Fn+Backspace 循环切换 |
  | 4 | 单色呼吸 (LightMode_04) | 同上 |
  | 5 | 多色渐变 (LightMode_05) | |
  | 6 | 按键按下时长亮 (LightMode_06) | UI 模拟：点按键亮/灭 |
  | 7 | 左右波浪 (LightMode_07) | |
  | 8 | 上下波浪 (LightMode_08) | |
  | 9 | 由中心向外扩散 (LightMode_09) | |
  | 12 | (LightMode_12) | 枚举存在但 UI 未列出；渲染层灯光模拟器按动画模式处理 |

- **无速度、亮度参数，无自定义 RGB 颜色下发**——官方灯效 UI 只有模式单选一组。
  单色模式颜色循环表（键盘 Fn+Backspace 循环，渲染层 `rgbTable`，共 9 色）：
  红 `[255,0,0]`、绿 `[0,255,0]`、蓝 `[0,0,255]`、橙红 `[255,69,0]`、春绿 `[0,255,127]`、
  湛蓝 `[30,144,255]`、黄 `[255,255,0]`、品红 `[255,0,255]`、青 `[0,255,255]`

### 8.3 对本项目的意义

- 「RGB 灯效自定义」功能在本协议范围内**无法实现**（没有可调参数，甚至没有开关命令）；
  除非固件未来 OTA 开放（观察点：新固件出现新 cmd 或 cmd 156/105 回包扩展字段）。
- 若仅想做"灯效开关"实验：可尝试向 AI 会话发传统 cmd 102 帧观察键盘是否响应——
  官方代码从未这样做过，成功率低，属探索性质，不影响主功能。

## 9. 固件与 OTA（2026-08-22 调查，决策：暂不深挖）

### 9.1 官方固件获取链路（实测可用）

- 版本查询：`GET http://mic.mimouse.net/dfs/hardware/judge/latest/version?type=mouse&system=win&deviceType=R87ProAI`
  → `data.versionNum` + `data.bin.installName`。**deviceType 大小写敏感**（`R87ProAI` 命中；
  `R87ProAIB`/hidType 值/PID 值均返回"没有上传最新的版本"）
- 固件下载：`GET http://mic.mimouse.net/dfs/hardware/install/download?fileName=<installName>`
  （参数名 `fileName`，N 大写；小写报 400）
- 2026-08 时最新：`ota-r87proai-mouse_bin_1.1.4.6_small.zip`（2025-03-24 构建）

### 9.2 固件包分析结论

- 解压得 `ota-mouse.bin`（93700 字节）：**Telink 芯片固件**（内含字符串
  `Telink Remote` / `MiMouse` / `R87Pro Ai` / `www.rkgaming.com/download/1/`）
- 整体熵 6.4~7.1：未压缩未加密，可静态分析；0x4000~0x8000 为空白 flash
- 无连续帧头立即数（协议帧逐字节比较），未发现现成 gamma/正弦灯表特征
- 深挖瓶颈：Telink TC32 自研指令集，主流反编译器不直接支持

### 9.3 OTA 传输协议（逆向自官方 `hid_core`，供参考勿乱用）

- `startFwOta`：键盘固件与 dongle 固件两份镜像，`fwDataChannel` 0/1=键盘、2=接收器（dongle 也是独立 MCU）
- 流程：cmd=8 OtaOpen（携带固件前 16 字节头）→ cmd=9 FwData（16 字节/包，offset 小端）→ cmd=11 Restart
- ⚠️ 写错固件可变砖，本项目不实现固件刷写

### 9.4 灯效后续可行路径（存档，当前不执行）

1. **Fn 切灯抓包**（零风险）：键盘 Fn 切灯效时用 tools/listen.js 观察是否上报灯效状态帧，命中即得 cmd 号
2. **安全号段盲测**：向 AI 会话试发传统协议 cmd 101/102（同厂 SDK 复用可能性）；避开 OTA(8-11)/改键(24)/恢复(25)
3. **固件静态分析**：TC32 手工逆向，成本高，兜底
