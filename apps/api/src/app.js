import express from "express";
import {pool} from "./config/database.js";

const app = express();

app.use(express.json()); // 解析 JSON 格式

//測試API路由
app.get('/api/v1/health', (req, res) => {
    res.status(200).json({ 
        success: true,
        message: 'API 正常運作',
        data:{
            status: 'ok'
        }
    })
});

app.get('/api/v1/health/db', async (req, res) => {
    try{
        const result = await pool.query('SELECT NOW() AS current_time');

        res.status(200).json({
            success: true,
            message: '資料庫連線正常',
            data: {
                current_time: result.rows[0].current_time
            }
        });
    } catch (error) {
        console.error('Error querying database:', error);

        res.status(503).json({
            success: false,
            error: {
                code: 'DB_UNAVAILABLE',
                message: '資料庫連線失敗'
            }
        });
    }
});

// 404 錯誤處理
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: {
            code: 'RESOURCE_NOT_FOUND',
            message: '找不到路由:${req.method} ${req.originalUrl}'
        }
    });
});

// 500 錯誤處理
app.use((error, req, res, next) => {
    console.error(error);

    res.status(500).json({
        success:false,
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: '伺服器內部錯誤'
        }
    });
});

export default app; // 導出 app 實例