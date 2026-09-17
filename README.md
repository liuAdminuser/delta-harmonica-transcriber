# 三角洲行动口琴转谱工具 · 桌面版 v2.0

基于 harmonica-app Electron 框架开发的桌面版口琴转谱工具。

## 功能特性

- **MP3/WAV 导入**：ffmpeg 自动转码为 22050Hz 单声道 WAV
- **AI 识别**：basic-pitch ONNX 模型进行多音高检测
- **主旋律提取**：onset 分组评分 + 大跳平滑 + outlier 清理 + 八度自适应
- **口琴自适应**：半音就近 round 到自然音阶 + 音域过滤
- **键位谱生成**：MIDI → 三角洲行动键位映射（可配置）
- **瀑布流跟吹**：播放/暂停/进度控制 + 键位高亮 + 鼠标操作提示
- **文本谱导出**：社区标准格式（数字=中音、(数字)=低音、【数字】=高音、#=升半音）
- **Windows 便携版**：双击即开，免装 Python/Node，模型随包

## 技术栈

- Electron 28（桌面窗口）
- ffmpeg-static（音频转码）
- basic-pitch ONNX（音高识别）
- Python 3.10+（AI 推理子进程）

## 开发运行

```bash
npm install
npm start
```

## 打包

```bash
npm run dist:win   # Windows 便携版 + 安装包
```

## 目录结构

```
harmonica-app/
  main.js          # 主进程（安全修复版）
  preload.js       # 预加载脚本
  renderer.js      # 渲染进程（DOM API 安全版）
  index.html       # 界面
  styles.css       # 样式
  keymap.json      # 键位映射配置
  transcribe.py    # 识别链路
  resources/       # 打包资源（模型、脚本、配置）
  test/            # 测试音频生成 + 命中率对比
```

## 安全修复（P0）

1. 路径遍历防护：`isValidFileName` + `safeJoin` 验证
2. XSS 防护：全部 `innerHTML` 替换为 `document.createElement` + `textContent`
3. 子进程超时：ffmpeg 60s / Python 300s，超自动 SIGKILL + 清理临时文件
4. 安全 JSON 解析：`safeJsonParse` 包装 + 异常处理

## 键位映射说明

默认键位基于社区调研假设，**待游戏内实测后修正**。可通过「设置」页或编辑 `keymap.json` 调整：

- `baseKeys`：8 个基础键位（1-7 + i）
- `octaveModifiers`：低音(左键)/中音(无)/高音(右键)
- `sharpModifier`：升半音(中键)

## 许可

MIT License
