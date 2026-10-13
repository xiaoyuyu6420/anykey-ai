// DeepFilterNet3 语音增强：koffi FFI 调 vendor/deep-filter/df.dll（Rust libDF C API）
// 模型：vendor/deep-filter/model/（DFN3 ONNX 导出），48kHz / hop 480 / 前瞻 2 帧 ≈ 30ms 算法延迟
// processFrame(Float32Array(480)) 原地增强，返回当前帧局部 SNR(dB) 可作 VAD 信号

const path = require('path');

// 打包后 vendor/deep-filter 经 asarUnpack 落在 app.asar.unpacked——koffi.load 走
// 原生 LoadLibrary/dlopen、df_create 走 Rust std::fs，都不经过 Electron 的 asar
// 补丁 fs，直接给 asar 内虚拟路径必失败。路径含 app.asar 时整体替换为解包路径。
function unpackedPath(p) { return p.replace(/\bapp\.asar\b/, 'app.asar.unpacked'); }

// 原生库按平台命名：CI 在各平台从源码编译（build.yml），本地开发可手动放置
const LIB_NAMES = { win32: 'df.dll', darwin: 'libdf.dylib', linux: 'libdf.so' };
const LIB_PATH = unpackedPath(path.join(__dirname, '../../vendor/deep-filter', LIB_NAMES[process.platform] || 'df.dll'));
const MODEL_PATH = unpackedPath(path.join(__dirname, '../../vendor/deep-filter/model/model.tar.gz'));

class DeepFilter {
  constructor() {
    this.ready = false;
    this.frameLen = 480;
    this._st = null;
    this._in = null;
    this._out = null;
  }

  // attenLimDb：最大衰减限制（dB）。越小降噪越保守；null 用默认 6dB
  init(attenLimDb = 3) {
    if (this.ready) return true;
    // df_create 对坏路径会原生 panic 直接杀进程——先自行校验文件存在
    const fs = require('fs');
    if (!fs.existsSync(LIB_PATH)) throw new Error('缺少 ' + LIB_PATH);
    if (!fs.existsSync(MODEL_PATH)) throw new Error('缺少模型 ' + MODEL_PATH);

    const koffi = require('koffi');
    const lib = koffi.load(LIB_PATH);
    this._create = lib.func('void* df_create(const char* path, float atten_lim, const char* log_level)');
    this._frameLenFn = lib.func('unsigned long long df_get_frame_length(void* st)');
    this._process = lib.func('float df_process_frame(void* st, float* input, float* output)');
    this._setAtten = lib.func('void df_set_atten_lim(void* st, float lim_db)');
    this._free = lib.func('void df_free(void* st)');

    this._st = this._create(MODEL_PATH, attenLimDb, null);
    this.attenLimDb = attenLimDb;
    if (!this._st) throw new Error('df_create 失败（模型加载错误）');
    this.frameLen = Number(this._frameLenFn(this._st));
    // 帧长校验：stub 环境/异常返回下避免分配出坏缓冲
    if (!Number.isInteger(this.frameLen) || this.frameLen < 120 || this.frameLen > 4096) {
      throw new Error('df_get_frame_length 异常: ' + this.frameLen);
    }
    this._in = new Float32Array(this.frameLen);
    this._out = new Float32Array(this.frameLen);
    this.ready = true;
    return true;
  }

  // 运行时调衰减上限，无需重建引擎（df_set_atten_lim）。
  // 远距说话时噪声与语音一起进来，过强降噪会把 s/sh 辅音当噪声吃掉——
  // 调小 attenLim（更保守）能保住辅音，代价是残余底噪略高。
  setAttenLim(db) {
    if (!this.ready || !this._setAtten) return false;
    const v = Math.max(0, Math.min(24, Number(db)));
    if (!Number.isFinite(v)) return false;
    this._setAtten(this._st, v);
    this.attenLimDb = v;
    return true;
  }

  // 输入输出同一 Float32Array(480)，原地替换为增强后音频；返回局部 SNR dB
  processFrame(f48) {
    this._in.set(f48);
    const snr = this._process(this._st, this._in, this._out);
    f48.set(this._out);
    return snr;
  }

  destroy() {
    if (!this.ready) return;
    try { this._free(this._st); } catch (_) {}
    this.ready = false;
  }
}

module.exports = { DeepFilter };
