# AnyKey AI 推广文案包

> 目标：收集 **200 份真实用户反馈**（追踪表见 [FEEDBACK-TRACKER.md](FEEDBACK-TRACKER.md)）。
> 发布节奏建议：每周 2-3 个平台，同一平台不要刷屏；每帖都带上反馈帖链接，反馈进来后在追踪表记一笔。
> 落地链接（发帖必带其一）：
> - 仓库：https://github.com/xiaoyuyu6420/anykey-ai
> - 下载：https://github.com/xiaoyuyu6420/anykey-ai/releases/latest
> - 反馈帖：https://github.com/xiaoyuyu6420/anykey-ai/discussions/13

---

## 一、V2EX（节点：分享创造 / 硬件）

**标题**：RK R87 Pro AI 键盘不开官方软件就没法用？我把它逆向了，功能键+麦克风全平台开源替代

**正文**：

买了把 RK R87 Pro AI 键盘，AI 键和 F 区那 14 个键必须装官方 RK-AI 才能用，麦克风也只有官方软件能开。官方软件是 Electron 的，源码没打包，索性把协议逆向了，写了个开源替代：**anykey-ai**。

能干什么：

- 14 个 AI 模式键（AI 键 + F1~F12 + PrtSc）随便映射：启动程序 / 开网址 / 发快捷键，支持启动后补发快捷键（比如一键唤起某 AI 助手并聚焦输入框）
- 键盘麦克风变成系统虚拟麦克风：装个 VB-Cable / BlackHole，任何软件（微信输入法语音、会议软件）都能用键盘麦
- 打字统计：纯本地只记按键次数，不记内容和顺序

技术上有几个点可能有人感兴趣：

1. 协议逆向自官方 Electron 明文源码 + 三轮实机 HID 抓包标定，键位键码全表在 README
2. 蓝牙（8243）和有线/2.4G（8102）走不同通道，蓝牙 F1 / 2.4G F0 命令帧，多口并存自动轮询握手
3. 音频是厂商私有 SBC 变种（mi-sbc），16kHz + AGC/高通/噪声门，降噪接了 RNNoise 和 DeepFilterNet3 双引擎
4. 完整协议文档开源：docs/protocol.md，想适配其他 RK 键盘的可以直接参考

Win/macOS 双平台，免安装 portable，纯本地不联网。GitHub 搜 anykey-ai 或直接：https://github.com/xiaoyuyu6420/anykey-ai

正在收集 200 份真实反馈决定下一步（键盘改键协议已经定位了），用同款键盘的帮忙试试，哪里难用直接骂：https://github.com/xiaoyuyu6420/anykey-ai/discussions/13

---

## 二、酷安

**标题**：RK R87 Pro AI 键盘的 AI 键，不装官方软件也能用了（开源）

**正文**：

痛点开场：RK R87 Pro AI 的 AI 键/F1-F12 那排，不装官方 RK-AI 就是废的；装了又常驻后台、还只有 Windows。

自己写了个开源工具 anykey-ai（Win/Mac 都行）：

⌨️ 14 个键随便改：启动程序、开网址、发快捷键，一键直达 AI 助手
🎙️ 键盘麦克风变系统麦克风，微信语音输入、开会都能用键盘麦
📊 附带打字统计（纯本地，不上传）

免安装，下载双击就能用，协议全逆向开源了。
GitHub：anykey-ai（xiaoyuyu6420）

用同款键盘的酷友帮忙测测，反馈链接评论区/主页，收集 200 份反馈迭代下一版 🙏

---

## 三、小红书

**标题**：这把百元键盘的 AI 键，被我改造成效率神器了⌨️

**正文**：

RK R87 Pro AI 键盘自带一排「AI 键」，但必须装官方软件才能用，Mac 用户直接被抛弃😭

自己动手写了开源工具，现在这排键想干嘛干嘛：

✨ F1 一键打开 ChatGPT 并自动聚焦输入框
✨ F11 一键唤起翻译
✨ 键盘上的麦克风，微信语音输入/腾讯会议都能直接用（不用官方软件！）
✨ 还能统计每天打了多少字（摸鱼实锤工具）

免费开源，Win/Mac 都支持，GitHub 搜「anykey-ai」就有教程。

同款键盘的姐妹试试？哪里看不懂直接评论区骂我，收集反馈中，目标是 200 条真实评价🙏

#键盘 #效率工具 #开源项目 #RK键盘 #数码好物

---

## 四、B 站动态

把 RK R87 Pro AI 键盘的 AI 键盘全破解了，开源了：14 个键随便映射、键盘麦克风全软件可用、还带打字统计。Win/Mac 免安装。GitHub 搜 anykey-ai。正在收集 200 份真实反馈，想要什么功能评论区提，点赞最高的先做。

---

## 五、Reddit（r/MechanicalKeyboards 或 r/keyboard 相关）

**Title**: I reverse-engineered the RK R87 Pro AI keyboard so its AI keys & mic work without the official (Windows-only) software — open source, cross-platform

**Body**:

The RK R87 Pro AI keyboard has 14 "AI keys" (AI + F1-F12 + PrtSc) and a built-in mic that only work with the official RK-AI software — Windows only, Electron, always running.

I reverse-engineered the protocol from the official app's plain-text source plus HID capture sessions, and built an open-source replacement: **anykey-ai** (Windows + macOS).

What it does:

- Remap all 14 keys to launch apps / open URLs / send hotkeys (with optional follow-up hotkey — one-key launch for your favorite AI assistant)
- Bridge the keyboard mic into a system-wide virtual microphone (VB-Cable / BlackHole) so ANY app can use it — voice typing, meetings, whatever
- Local-only typing stats (key counts, no content)

Full protocol documentation is in the repo (docs/protocol.md) if you want to adapt it to other RK models. Everything runs locally, nothing phones home.

Repo: https://github.com/xiaoyuyu6420/anykey-ai

I'm collecting 200 pieces of real user feedback to decide the roadmap (key remapping on the keyboard itself is next). If you have this board, tell me what's broken or missing: https://github.com/xiaoyuyu6420/anykey-ai/discussions/13

---

## 六、少数派 / 即刻（通用短版）

给 RK R87 Pro AI 键盘写了开源替代工具：不装官方软件，14 个 AI 功能键随便映射（一键直达 AI 助手）、键盘麦克风变成系统级麦克风、附带纯本地打字统计。Win/Mac 双平台免安装，协议逆向全文档开源。正在收集 200 份真实反馈定路线图，欢迎试用+吐槽：https://github.com/xiaoyuyu6420/anykey-ai

---

## 发布检查清单（每帖发前过一遍）

- [ ] 链接可点（不是纯文字）
- [ ] 带反馈帖链接 discussions/13 或引导到评论区
- [ ] 符合平台规则（V2EX 分享创造允许自推；小红书别带太多外链词）
- [ ] 发完记入 FEEDBACK-TRACKER.md
