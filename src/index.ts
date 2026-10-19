import 'dotenv/config'
import cors from 'cors'
import express from 'express'

const app = express();
const port = process.env.PORT ?? 8080;
const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:3000';

app.use(cors({
    origin: clientUrl,
    credentials: true
}))
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({status: 'ok'});
})

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
})