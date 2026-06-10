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
Voce eh um assistente juridico da Seguros Parana, especializado em Auxilio-Acidente (DPVAT/INSS).

REGRAS:
- Extraia TODOS os dados dos documentos de forma explicita e objetiva.
- Nunca invente dados. Use apenas o que foi fornecido.
- Quando nao encontrar uma informacao, retorne exatamente "Nao apurado" (nunca "undefined", nunca vazio, nunca "N/A").
- Copie informacoes EXATAMENTE como constam nos documentos, sem corrigir.
- Use linguagem formal e juridicamente adequada.

AFASTAMENTOS (perguntas 24, 25, 28):
Quando houver multiplos beneficios no arquivo "declaracao-de-beneficio", use o beneficio cujo ANO DE INICIO seja igual ou mais proximo (posterior) ao ANO da data do acidente para as perguntas 24 e 25. Os demais vao para a pergunta 28.
Formato pergunta 25: "X meses e X dias. dd/mm/aaaa - dd/mm/aaaa"
Formato pergunta 28: "TIPO - NUMERO - dd/mm/aaaa - dd/mm/aaaa" (um por linha)
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
    model: "gemini-2.5-flash",
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

    console.log("\n========================================");
    console.log("[AI CHAT] Nova requisição recebida");
    console.log("========================================");
    console.log(`[AI CHAT] Total de mensagens: ${messages?.length ?? 0}`);
    console.log(`[AI CHAT] Contexto do card: ${contextMessage ? "SIM (" + contextMessage.length + " chars)" : "NÃO"}`);
    console.log(`[AI CHAT] Attachments (array): ${attachments ? attachments.length + " arquivo(s)" : "NENHUM"}`);
    console.log(`[AI CHAT] Attachment (single): ${attachment ? "SIM" : "NÃO"}`);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Mensagens não fornecidas" });
    }

    // Log each message
    messages.forEach((msg, i) => {
      console.log(`[AI CHAT] Mensagem [${i}] role="${msg.role}" | ${msg.content?.length ?? 0} chars | preview: "${(msg.content || "").substring(0, 100)}..."`);
    });

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

    // Process attachments with detailed logging
    let fileCount = 0;

    if (attachments && Array.isArray(attachments)) {
      console.log(`\n[AI CHAT] ---- Processando ${attachments.length} anexo(s) ----`);
      for (let idx = 0; idx < attachments.length; idx++) {
        const att = attachments[idx];
        const fileName = att.name || "(sem nome)";
        const declaredType = att.type || "(sem tipo)";

        if (att.fileUri && att.mimeType) {
          console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → fileUri (upload Gemini)`);
          console.log(`  - fileUri: ${att.fileUri}`);
          console.log(`  - mimeType: ${att.mimeType}`);
          parts.push({ fileData: { fileUri: att.fileUri, mimeType: att.mimeType } });
          fileCount++;
        } else if (att.content) {
          const mimeType = resolveMimeType(att.name ?? "", att.type ?? "");
          const sizeBytes = att.content.length;
          const sizeKB = (sizeBytes * 0.75 / 1024).toFixed(1); // base64 → real size approx

          if (mimeType) {
            console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → inlineData`);
            console.log(`  - tipo declarado: ${declaredType}`);
            console.log(`  - mimeType resolvido: ${mimeType}`);
            console.log(`  - tamanho base64: ${sizeBytes} chars (~${sizeKB} KB real)`);
            console.log(`  - primeiros 100 chars do content: "${att.content.substring(0, 100)}..."`);
            parts.push({ inlineData: { mimeType, data: att.content } });
            fileCount++;
          } else {
            console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → REJEITADO (formato não suportado)`);
            console.log(`  - tipo declarado: ${declaredType}`);
            console.log(`  - tamanho base64: ${sizeBytes} chars`);
            parts.push({ text: `[Arquivo "${att.name}" não pôde ser analisado — formato não suportado]` });
          }
        } else {
          console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → IGNORADO (sem content e sem fileUri)`);
        }
      }
    } else if (attachment?.content && attachment?.type) {
      const mimeType = resolveMimeType(attachment.name ?? "", attachment.type);
      const sizeBytes = attachment.content.length;
      const sizeKB = (sizeBytes * 0.75 / 1024).toFixed(1);

      console.log(`\n[AI CHAT] ---- Processando 1 anexo (singular) ----`);
      console.log(`[AI CHAT] Anexo "${attachment.name || "(sem nome)"}" | tipo: ${attachment.type}`);
      console.log(`  - mimeType resolvido: ${mimeType || "NÃO SUPORTADO"}`);
      console.log(`  - tamanho base64: ${sizeBytes} chars (~${sizeKB} KB real)`);

      if (mimeType) {
        parts.push({ inlineData: { mimeType, data: attachment.content } });
        fileCount++;
      }
    }

    console.log(`\n[AI CHAT] ---- Resumo final ----`);
    console.log(`[AI CHAT] Total de parts enviadas ao Gemini: ${parts.length}`);
    console.log(`[AI CHAT] - Textos: ${parts.filter(p => p.text).length}`);
    console.log(`[AI CHAT] - Arquivos (inlineData): ${parts.filter(p => p.inlineData).length}`);
    console.log(`[AI CHAT] - Arquivos (fileData/URI): ${parts.filter(p => p.fileData).length}`);
    console.log(`[AI CHAT] Arquivos aceitos: ${fileCount}`);
    console.log(`[AI CHAT] Histórico: ${history.length} mensagens anteriores`);
    console.log("[AI CHAT] Enviando para Gemini...\n");

    const result = await sendStreamWithRetry(chat, parts);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) res.write(text);
    }

    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;
    console.log("\n[AI CHAT] ---- Resposta do Gemini ----");
    console.log(`[AI CHAT] Tokens do Prompt: ${usage?.promptTokenCount ?? "?"}`);
    console.log(`[AI CHAT] Tokens da Resposta: ${usage?.candidatesTokenCount ?? "?"}`);
    console.log(`[AI CHAT] Tokens Total: ${usage?.totalTokenCount ?? "?"}`);
    console.log(`[AI CHAT] Finish reason: ${finalResponse.candidates?.[0]?.finishReason ?? "?"}`);
    console.log("========================================\n");

    res.end();
  } catch (error) {
    console.error("\n[AI CHAT] ❌ ERRO:", error);
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
  // Dados pessoais
  "name", "cpf", "rg", "email", "telefone", "telefone_secundario",
  "estado_civil", "nome_mae", "data_nascimento", "nacionalidade",
  "forma_contato", "redes_sociais", "senha_inss", "status",
  // Endereço
  "endereco", "rua", "bairro", "cidade", "estado", "numero", "cep",
  // Profissão
  "profissao", "profissao_epoca", "service",
  // Acidente
  "data_acidente", "como_acidente", "descricao_fatos",
  "ficou_internado", "fez_cirurgia", "envolveu_veiculo", "tem_bo",
  "lesoes", "hospital",
  // Sequelas
  "tem_sequelas", "quais_sequelas",
  // Trabalho / Afastamento
  "voltou_trabalhar", "ficou_afastado", "tempo_afastamento", "tem_cat",
  // Perícia
  "pericia_adm", "disponibilidade_pericia",
  // Outros
  "outros_afastamentos",
];

app.post("/ai/extract-fields", authCheck, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Conteúdo não fornecido" });
    }

    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `A partir do texto abaixo (respostas numeradas de uma análise de documentos de um cliente), extraia os valores para TODOS os campos listados.

REGRAS CRÍTICAS:
1. Retorne APENAS um JSON válido, sem markdown, sem blocos de código, sem explicação.
2. TODOS os campos devem estar presentes no JSON.
3. Copie o valor EXATAMENTE como aparece no texto — não corrija, não reformate, não resuma.
4. Se o texto diz "Não apurado." ou "Não apurada.", use exatamente esse texto como valor.
5. Se um campo realmente não aparece no texto, use "Não apurado" (nunca use string vazia "", nunca use "undefined", nunca use "null", nunca use "N/A").
6. Para campos de endereço, extraia cada parte separadamente (rua, bairro, cidade, estado, numero, cep).
7. Para o campo "quais_sequelas", mantenha cada sequela separada por quebra de linha (\\n).
8. Para "outros_afastamentos", mantenha cada afastamento separado por quebra de linha (\\n).

CAMPOS PARA EXTRAIR:
${EXTRACTABLE_FIELDS.map((f) => `- ${f}`).join("\n")}

MAPEAMENTO — como encontrar cada campo no texto:
- name: campo <<name>> ou pergunta 1
- cpf: campo <<cpf>> ou pergunta 9
- rg: campo <<rg>> ou pergunta 7
- email: campo <<email>>
- telefone: campo <<telefone>> ou pergunta 4
- telefone_secundario: campo <<telefone_secundario>> ou pergunta 5
- estado_civil: campo <<estado_civil>> ou pergunta 11
- nome_mae: se mencionado
- data_nascimento: se mencionado
- nacionalidade: se mencionado
- forma_contato: campo <<forma_contato>> ou pergunta 5 (segunda)
- redes_sociais: campo <<redes_sociais>> ou pergunta 6
- senha_inss: campo <<senha_inss>> ou pergunta 10
- status: campo <<status>> ou pergunta 11.1
- endereco/rua: parte do endereço na pergunta 8, o logradouro
- bairro: parte do endereço na pergunta 8
- cidade: parte do endereço na pergunta 8
- estado: parte do endereço na pergunta 8
- numero: parte do endereço na pergunta 8
- cep: parte do endereço na pergunta 8
- profissao: campo <<profissao>> ou pergunta 2
- profissao_epoca: campo <<profissao_epoca>> ou pergunta 3
- service: campo <<service>> — tipo de serviço (DPVAT, INSS, Seguro Vida)
- data_acidente: campo <<data_acidente>> ou pergunta 13
- como_acidente: campo <<como_acidente>> ou pergunta 14
- descricao_fatos: campo <<descricao_fatos>> ou pergunta 27
- ficou_internado: campo <<ficou_internado>> ou pergunta 16
- fez_cirurgia: campo <<fez_cirurgia>> ou pergunta 17
- envolveu_veiculo: campo <<envolveu_veiculo>> ou pergunta 21
- tem_bo: campo <<tem_bo>> ou pergunta 22
- lesoes: campo <<lesoes>> ou pergunta 18
- hospital: se mencionado
- tem_sequelas: campo <<tem_sequelas>> ou pergunta 19
- quais_sequelas: campo <<quais_sequelas>> ou pergunta 20
- voltou_trabalhar: campo <<voltou_trabalhar>> ou pergunta 23
- ficou_afastado: campo <<ficou_afastado>> ou pergunta 24
- tempo_afastamento: campo <<tempo_afastamento>> ou pergunta 25
- tem_cat: campo <<tem_cat>> ou pergunta 26
- pericia_adm: se mencionado
- disponibilidade_pericia: campo <<disponibilidade_pericia>> ou pergunta 12
- outros_afastamentos: pergunta 29 em conjunto com a 28

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
