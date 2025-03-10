const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cloud = require('wx-server-sdk');
const OpenAI = require('openai');
const { init: initDB, Counter } = require("./db");

// 初始化云开发环境
cloud.init({
  env: 'sybcloud1-6g6f3534e3ef9bb9'
});

const logger = morgan("tiny");
const app = express();


app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({
      truncate: true,
    });
  }
  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

// 添加生成内容的API端点
app.post("/api/generate", async (req, res) => {
  const { jobDescription } = req.body;
  
  if (!jobDescription) {
    return res.status(400).json({ success: false, error: '缺少职位描述参数' });
  }

  try {
    const db = cloud.database();
    const systemPrompt = await getSystemPromptFromStorage();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const apiKey = await getApiKeyFromDatabase();
    if (!apiKey) {
      const defaultContent = await getDefaultContentFromStorage();
      await db.collection('gen_tasks').add({
        data: {
          _id: taskId,
          status: 'completed',
          createTime: db.serverDate(),
          jobDescription,
          currentContent: defaultContent,
          totalTokens: defaultContent.length,
        }
      });
      return res.json({ success: true, taskId });
    }

    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    await db.collection('gen_tasks').add({
      data: {
        _id: taskId,
        status: 'processing',
        createTime: db.serverDate(),
        jobDescription,
        currentContent: '',
        totalTokens: 0,
      }
    });

    // 异步处理流式请求
    processStreamRequest(taskId, jobDescription, systemPrompt, openai);

    res.json({ success: true, taskId });
  } catch (err) {
    console.error('生成失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取任务状态的API端点
app.get("/api/task/:taskId", async (req, res) => {
  try {
    const db = cloud.database();
    const result = await db.collection('gen_tasks').doc(req.params.taskId).get();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();

// 将辅助函数放在文件末尾
async function getApiKeyFromDatabase() {
  const db = cloud.database();
  const result = await db.collection('keys').doc("1c5ac29f67c3bb4600311a493a34ede8").get(); 
  return result.data ? result.data.theKey : null; 
}

async function getDefaultContentFromStorage() {
  try {
    const result = await cloud.downloadFile({
      fileID: 'cloud://sybcloud1-6g6f3534e3ef9bb9.7379-sybcloud1-6g6f3534e3ef9bb9-1344626996/defaultJson.txt' 
    });
    return result.fileContent.toString('utf8');
  } catch (error) {
    console.error('读取默认内容失败:', error);
    return '';
  }
}

async function getSystemPromptFromStorage() {
  try {
    const result = await cloud.downloadFile({
      fileID: 'cloud://sybcloud1-6g6f3534e3ef9bb9.7379-sybcloud1-6g6f3534e3ef9bb9-1344626996/systemPrompt.txt'
    });
    return result.fileContent.toString('utf8');
  } catch (error) {
    console.error('读取system提示词失败:', error);
    return null;
  }
}

async function processStreamRequest(taskId, jobDescription, systemPrompt, openai) {
  const db = cloud.database();
  
  try {
    const stream = await openai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: jobDescription
        }
      ],
      model: 'doubao-1-5-pro-32k-250115',
      stream: true,
    });

    let fullContent = '';
    let updateTimer = null;
    const batchSize = 50;
    let elapsedTime = 0;
    const startTime = Date.now();

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullContent += content;
        
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = setTimeout(async () => {
          try {
            elapsedTime = Math.floor((Date.now() - startTime) / 1000);
            await db.collection('gen_tasks').doc(taskId).update({
              data: {
                currentContent: fullContent,
                totalTokens: fullContent.length,
                elapsedTime: elapsedTime,
                updateTime: db.serverDate()
              }
            });
          } catch (error) {
            console.error('更新进度失败:', error);
          }
        }, 200);
      }
    }

    elapsedTime = Math.floor((Date.now() - startTime) / 1000);
    await db.collection('gen_tasks').doc(taskId).update({
      data: {
        status: 'completed',
        currentContent: fullContent,
        totalTokens: fullContent.length,
        elapsedTime: elapsedTime,
        updateTime: db.serverDate()
      }
    });

  } catch (error) {
    console.error('流式生成失败:', error);
    
    const defaultContent = await getDefaultContentFromStorage();
    
    await db.collection('gen_tasks').doc(taskId).update({
      data: {
        status: 'failed',
        error: error.message,
        currentContent: defaultContent,
        totalTokens: defaultContent.length,
        updateTime: db.serverDate()
      }
    });
  }
}
