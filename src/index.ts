import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { errorHandler } from './middleware/error-handler.middleware.js';
import { registerRoutes } from './routes/index.js';

const app = express();
const port = process.env.PORT ?? 8080;
const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:3000';

app.use(cors({
    origin: clientUrl,
    credentials: true
}))
app.use(express.json());

app.get("/", (_req, res) => {
    res.json({ message: "Hello from Grounded Notebook API" });
});

app.get('/health', (_req, res) => {
    res.json({status: 'ok'});
})

registerRoutes(app);

app.use(errorHandler);

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
})