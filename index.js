const express = require("express");
const libre = require("libreoffice-convert");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.CONVERTER_API_KEY || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// Parsers
app.use("/convert", express.raw({ type: "application/octet-stream", limit: "20mb" }));
app.use("/ai", express.json({ limit: "50mb" }));

// Auth middleware
function authCheck(req, res, next) {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// =============================================
// DOCX → PDF conversion
// =============================================
app.post("/convert", authCheck, (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: "No file provided" });
  }

  libre.convert(req.body, "pdf", undefined, (err, result) => {
    if (err) {
      console.error("Conversion error:", err);
      return res.status(500).json({ error: "Conversion failed" });
    }

    res.set("Content-Type", "application/pdf");
    res.send(result);
  });
});

// =============================================
// AI — Gemini Chat (streaming)
// =============================================

const SYSTEM_INSTRUCTION = `
Você é um assistente jurídico especializado da Seguros Paraná.
Seu papel é ajudar a equipe administrativa com análise de documentos e geração de peças relacionadas a processos de Auxílio-Acidente (DPVAT/INSS).

SUAS CAPACIDADES:
1. ANÁLISE DE DOCUMENTOS: Quando receber documentos (PDF, imagem, etc), extraia e organize claramente

2. CRIAÇÃO DE DOCUMENTOS: Com base nas informações do cliente/processo e documentos analisados, você pode gerar:
   - Roteiros

REGRAS:
- Sempre use linguagem formal e juridicamente adequada nos documentos gerados
- Ao analisar documentos, extraia TODOS os dados relevantes de forma explícita — eles serão usados para preencher o roteiro automaticamente
- Nunca invente dados — use apenas o que foi fornecido
- Se faltar informação para gerar um documento, pergunte o que precisa
- Formate suas respostas com markdown para melhor leitura
- Quando gerar um documento, apresente-o completo e pronto para uso
`;

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif",
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac",
  "video/mp4", "video/mpeg", "video/mov", "video/avi", "video/x-flv", "video/mpg", "video/webm", "video/wmv", "video/3gpp",
  "text/plain", "text/html", "text/css", "text/javascript", "text/x-typescript",
  "text/csv", "text/markdown", "text/x-python", "text/x-java", "text/xml", "text/rtf",
]);

const EXT_TO_MIME = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  txt: "text/plain", csv: "text/csv", html: "text/html", htm: "text/html",
  md: "text/markdown", markdown: "text/markdown",
  xml: "text/xml", rtf: "text/rtf",
  js: "text/javascript", ts: "text/x-typescript",
  py: "text/x-python", java: "text/x-java",
  mp3: "audio/mp3", wav: "audio/wav", ogg: "audio/ogg",
  aac: "audio/aac", flac: "audio/flac", aiff: "audio/aiff",
  mp4: "video/mp4", mov: "video/mov", avi: "video/avi",
  webm: "video/webm", wmv: "video/wmv",
};

function resolveMimeType(filename, declaredType) {
  if (SUPPORTED_MIME_TYPES.has(declaredType)) return declaredType;
  const ext = (filename || "").split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? null;
}

function getModel() {
  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: SYSTEM_INSTRUCTION,
  });
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

async function sendStreamWithRetry(chat, parts, attempt = 1) {
  try {
    return await chat.sendMessageStream(parts);
  } catch (error) {
    const status = error?.status;
    const isRetryable = status === 503 || status === 429;

    if (!isRetryable || attempt > MAX_RETRIES) throw error;

    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
    console.log(`[AI] Retry ${attempt}/${MAX_RETRIES} (${status}), waiting ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
    return sendStreamWithRetry(chat, parts, attempt + 1);
  }
}

app.post("/ai/chat", authCheck, async (req, res) => {
  try {
    const { messages, contextMessage, attachments, attachment } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Mensagens não fornecidas" });
    }

    const model = getModel();

    const history = messages.slice(0, -1).map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const lastMessage = messages[messages.length - 1];
    const chat = model.startChat({ history });
    const parts = [];

    if (contextMessage && history.length === 0) {
      parts.push({ text: `${contextMessage}\n\n${lastMessage.content}` });
    } else {
      parts.push({ text: lastMessage.content });
    }

    // Process attachments
    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.fileUri && att.mimeType) {
          parts.push({ fileData: { fileUri: att.fileUri, mimeType: att.mimeType } });
        } else if (att.content) {
          const mimeType = resolveMimeType(att.name ?? "", att.type ?? "");
          if (mimeType) {
            parts.push({ inlineData: { mimeType, data: att.content } });
          } else {
            parts.push({ text: `[Arquivo "${att.name}" não pôde ser analisado — formato não suportado]` });
          }
        }
      }
    } else if (attachment?.content && attachment?.type) {
      const mimeType = resolveMimeType(attachment.name ?? "", attachment.type);
      if (mimeType) {
        parts.push({ inlineData: { mimeType, data: attachment.content } });
      }
    }

    const result = await sendStreamWithRetry(chat, parts);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) res.write(text);
    }

    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;
    console.log(
      `[AI] Tokens — Prompt: ${usage?.promptTokenCount ?? "?"} | Response: ${usage?.candidatesTokenCount ?? "?"} | Total: ${usage?.totalTokenCount ?? "?"}`
    );

    res.end();
  } catch (error) {
    console.error("[AI] Chat error:", error);
    const status = error?.status || 500;
    let message = "Erro ao processar mensagem com IA.";
    if (status === 503) message = "Servidor sobrecarregado. Tente novamente em 1 minuto.";
    else if (status === 429) message = "Limite de requisições excedido. Aguarde alguns minutos.";

    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
  }
});

// =============================================
// AI — Extract fields from content
// =============================================

const EXTRACTABLE_FIELDS = [
  "descricao_fatos", "como_acidente", "ficou_internado", "fez_cirurgia",
  "envolveu_veiculo", "tem_bo", "tem_sequelas", "quais_sequelas",
  "voltou_trabalhar", "ficou_afastado", "tempo_afastamento", "tem_cat",
  "pericia_adm", "disponibilidade_pericia", "service", "profissao",
  "profissao_epoca", "forma_contato", "redes_sociais", "telefone_secundario", "senha_inss",
];

app.post("/ai/extract-fields", authCheck, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Conteúdo não fornecido" });
    }

    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const prompt = `A partir do texto abaixo (análise de documentos de um cliente), extraia os valores para os campos listados.
Retorne APENAS um JSON válido com os campos como chaves e string como valor.
Se um campo não puder ser determinado a partir do texto, use string vazia "".
Responda SOMENTE o JSON puro, sem markdown, sem blocos de código, sem explicação.

CAMPOS PARA EXTRAIR:
${EXTRACTABLE_FIELDS.map((f) => `- ${f}`).join("\n")}

Descrições dos campos:
- descricao_fatos: resumo geral do caso/acidente em linguagem formal
- como_acidente: como ocorreu o acidente (narrativa)
- ficou_internado: sim/não — ficou internado no hospital
- fez_cirurgia: sim/não — realizou cirurgia
- envolveu_veiculo: sim/não e se era próprio ou de terceiros
- tem_bo: sim/não — possui Boletim de Ocorrência
- tem_sequelas: sim/não — possui sequelas
- quais_sequelas: descrição das sequelas
- voltou_trabalhar: sim/não — voltou a trabalhar
- ficou_afastado: sim/não — ficou afastado pelo INSS
- tempo_afastamento: quanto tempo ficou afastado
- tem_cat: sim/não — possui CAT (Comunicação de Acidente de Trabalho)
- pericia_adm: sim/não — necessário marcar perícia administrativa
- disponibilidade_pericia: disponibilidade para perícia na capital
- service: assunto/tipo de serviço (ex: DPVAT, INSS, Seguro Vida)
- profissao: profissão atual do cliente
- profissao_epoca: profissão na época do acidente
- forma_contato: melhor forma de contato
- redes_sociais: redes sociais do cliente
- telefone_secundario: telefone secundário
- senha_inss: senha de acesso ao INSS (se mencionado)

TEXTO DA CONVERSA/ANÁLISE:
${content}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const json = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");
    const fields = JSON.parse(json);

    res.json(fields);
  } catch (error) {
    console.error("[AI] Extract fields error:", error);
    res.status(500).json({ error: "Erro ao extrair campos" });
  }
});

// =============================================
// Health check
// =============================================
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`docx-converter running on port ${PORT}`);
});
