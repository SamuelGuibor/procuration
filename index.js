require("dotenv").config();

const express = require("express");
const libre = require("libreoffice-convert");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.CONVERTER_API_KEY || "";

// Aceita CLAUDE_API_KEY (nome custom usado neste projeto) ou ANTHROPIC_API_KEY
// (nome padrão lido pelo SDK). Damos prioridade ao Anthropic padrão.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

console.log("Configurações:", ANTHROPIC_API_KEY);

const CLAUDE_MODEL = "claude-haiku-4-5";

// Modelos que suportam adaptive thinking. Haiku 4.5 NÃO suporta.
const ADAPTIVE_THINKING_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
]);

function supportsAdaptiveThinking(model) {
  return ADAPTIVE_THINKING_MODELS.has(model);
}

// Cliente Anthropic — explícito para tolerar variável de ambiente custom.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Parsers
app.use(cors());
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
// AI — Claude Chat (streaming)
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

========================================
FORMATO DE SAIDA (OBRIGATORIO ao gerar o roteiro)
========================================
Quando o usuario pedir o roteiro / a analise dos documentos, responda SEMPRE
com uma linha por campo, no formato EXATO abaixo (o sistema le essas tags
automaticamente para preencher o documento):

    N - <<tag>>: valor

Regras do formato:
- Use EXATAMENTE as tags abaixo, entre << >>. Nunca traduza, renomeie ou invente tags.
- Uma tag por linha. Sempre inclua a tag, mesmo que o valor seja "Nao apurado".
- Nao use markdown (nada de **negrito**, listas com *, tabelas). Apenas "N - <<tag>>: valor".
- Para campos com varios itens (quais_sequelas, outros_afastamentos), coloque
  cada item em uma nova linha logo abaixo da tag.
- Endereco (pergunta 8): NAO junte tudo numa tag so. Separe em <<rua>>, <<numero>>,
  <<bairro>>, <<cidade>>, <<estado>>, <<cep>>.

Tags e a pergunta correspondente:
1   - <<name>>: nome completo
2   - <<profissao>>: profissao atual
3   - <<profissao_epoca>>: profissao na epoca do acidente
4   - <<telefone>>: telefone principal
5   - <<telefone_secundario>>: telefone secundario
5   - <<forma_contato>>: forma de contato preferida
6   - <<redes_sociais>>: redes sociais
7   - <<rg>>: RG
8   - <<rua>>: logradouro
8   - <<numero>>: numero
8   - <<bairro>>: bairro
8   - <<cidade>>: cidade
8   - <<estado>>: estado/UF
8   - <<cep>>: CEP
9   - <<cpf>>: CPF
10  - <<senha_inss>>: senha do INSS / gov.br
11  - <<estado_civil>>: estado civil
11.1- <<status>>: status
12  - <<disponibilidade_pericia>>: disponibilidade para pericia
13  - <<data_acidente>>: data do acidente
14  - <<como_acidente>>: como ocorreu o acidente
16  - <<ficou_internado>>: ficou internado?
17  - <<fez_cirurgia>>: fez cirurgia?
18  - <<lesoes>>: lesoes
19  - <<tem_sequelas>>: tem sequelas?
20  - <<quais_sequelas>>: quais sequelas (uma por linha)
21  - <<envolveu_veiculo>>: envolveu veiculo?
22  - <<tem_bo>>: tem boletim de ocorrencia?
23  - <<voltou_trabalhar>>: voltou a trabalhar?
24  - <<ficou_afastado>>: ficou afastado?
25  - <<tempo_afastamento>>: tempo de afastamento (X meses e X dias. dd/mm/aaaa - dd/mm/aaaa)
26  - <<tem_cat>>: tem CAT?
27  - <<descricao_fatos>>: descricao dos fatos
28  - <<outros_afastamentos>>: outros afastamentos (um por linha: TIPO - NUMERO - dd/mm/aaaa - dd/mm/aaaa)
`.trim();

// Tipos MIME que o Claude aceita nativamente como content block.
// - Imagens: image block (jpeg/png/gif/webp)
// - PDFs: document block
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const EXT_TO_MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  xml: "text/xml",
  rtf: "text/rtf",
  js: "text/javascript",
  ts: "text/x-typescript",
  py: "text/x-python",
  java: "text/x-java",
};

function resolveMimeType(filename, declaredType) {
  if (declaredType && (IMAGE_MIME_TYPES.has(declaredType) || declaredType === "application/pdf" || declaredType.startsWith("text/"))) {
    return declaredType;
  }
  const ext = (filename || "").split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? null;
}

// Tenta decodificar base64 para string (para arquivos de texto).
function tryDecodeTextBase64(base64) {
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// Converte um anexo (do payload) em um content block do Claude.
// Retorna null se o formato não é suportado.
function buildContentBlockFromAttachment(att) {
  if (!att) return null;
  const fileName = att.name || "(sem nome)";
  const mimeType = resolveMimeType(fileName, att.type || "");

  if (!mimeType) return null;

  // PDFs → document block (base64)
  if (mimeType === "application/pdf") {
    if (!att.content) return null;
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: att.content,
      },
      title: fileName,
    };
  }

  // Imagens suportadas → image block (base64)
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (!att.content) return null;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: att.content,
      },
    };
  }

  // Texto (txt, csv, md, html, xml, js, ts, py, java...) → text block inline.
  if (mimeType.startsWith("text/")) {
    if (!att.content) return null;
    const decoded = tryDecodeTextBase64(att.content);
    if (!decoded) return null;
    return {
      type: "text",
      text: `[Arquivo "${fileName}"]\n${decoded}`,
    };
  }

  return null;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

function isRetryableStatus(status) {
  return status === 429 || status === 503 || status === 529;
}

async function withRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (error) {
    const status = error?.status;
    if (!isRetryableStatus(status) || attempt > MAX_RETRIES) throw error;
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
    console.log(`[AI] Retry ${attempt}/${MAX_RETRIES} (status=${status}), aguardando ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
    return withRetry(fn, attempt + 1);
  }
}

app.post("/ai/chat", authCheck, async (req, res) => {
  try {
    const { messages, contextMessage, attachments, attachment } = req.body;

    console.log("\n========================================");
    console.log("[AI CHAT] Nova requisição recebida");
    console.log("========================================");
    console.log(`[AI CHAT] Modelo: ${CLAUDE_MODEL}`);
    console.log(`[AI CHAT] Total de mensagens: ${messages?.length ?? 0}`);
    console.log(`[AI CHAT] Contexto do card: ${contextMessage ? "SIM (" + contextMessage.length + " chars)" : "NÃO"}`);
    console.log(`[AI CHAT] Attachments (array): ${attachments ? attachments.length + " arquivo(s)" : "NENHUM"}`);
    console.log(`[AI CHAT] Attachment (single): ${attachment ? "SIM" : "NÃO"}`);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Mensagens não fornecidas" });
    }

    messages.forEach((msg, i) => {
      console.log(`[AI CHAT] Mensagem [${i}] role="${msg.role}" | ${msg.content?.length ?? 0} chars | preview: "${(msg.content || "").substring(0, 100)}..."`);
    });

    // ---- Monta histórico no formato Anthropic (user|assistant) ----
    const history = messages.slice(0, -1).map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }));

    const lastMessage = messages[messages.length - 1];
    const lastText = (lastMessage?.content ?? "").trim();

    // Última mensagem do usuário pode conter texto + anexos (multimodal).
    const lastContent = [];

    // Se for a primeira interação e tiver context do card, antecipa.
    const userText =
      contextMessage && history.length === 0
        ? `${contextMessage}\n\n${lastText}`
        : lastText;

    if (userText) {
      lastContent.push({ type: "text", text: userText });
    }

    // ---- Processa anexos ----
    let acceptedFiles = 0;
    let rejectedFiles = 0;

    const attachmentList = Array.isArray(attachments)
      ? attachments
      : attachment
      ? [attachment]
      : [];

    if (attachmentList.length > 0) {
      console.log(`\n[AI CHAT] ---- Processando ${attachmentList.length} anexo(s) ----`);
      for (let idx = 0; idx < attachmentList.length; idx++) {
        const att = attachmentList[idx];
        const fileName = att?.name || "(sem nome)";
        const block = buildContentBlockFromAttachment(att);

        if (block) {
          console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → ${block.type} (${block.source?.media_type ?? "text"})`);
          lastContent.push(block);
          acceptedFiles++;
        } else {
          console.log(`[AI CHAT] Anexo [${idx}] "${fileName}" → REJEITADO (formato não suportado pelo Claude)`);
          lastContent.push({
            type: "text",
            text: `[Arquivo "${fileName}" não pôde ser analisado — formato não suportado]`,
          });
          rejectedFiles++;
        }
      }
    }

    // Garante pelo menos um content block.
    if (lastContent.length === 0) {
      lastContent.push({ type: "text", text: "" });
    }

    const fullMessages = [
      ...history,
      { role: "user", content: lastContent },
    ];

    console.log(`\n[AI CHAT] ---- Resumo final ----`);
    console.log(`[AI CHAT] Total de blocks na última mensagem: ${lastContent.length}`);
    console.log(`[AI CHAT]  - Textos: ${lastContent.filter((b) => b.type === "text").length}`);
    console.log(`[AI CHAT]  - Documentos (PDF): ${lastContent.filter((b) => b.type === "document").length}`);
    console.log(`[AI CHAT]  - Imagens: ${lastContent.filter((b) => b.type === "image").length}`);
    console.log(`[AI CHAT] Arquivos aceitos: ${acceptedFiles} | rejeitados: ${rejectedFiles}`);
    console.log(`[AI CHAT] Histórico: ${history.length} mensagens anteriores`);
    console.log(`[AI CHAT] Enviando para Claude (${CLAUDE_MODEL})...\n`);

    // ---- Headers para streaming ----
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

   // ---- Prompt caching ----
    // 1) Cacheia o SYSTEM_INSTRUCTION (estável entre requisições).
    // 2) Marca o ÚLTIMO bloco "pesado" da última mensagem (PDF ou imagem)
    //    com cache_control — assim o Claude cacheia tudo até ele, e o
    //    próximo turn paga ~10% do input ao invés de 100%.
    const systemWithCache = [
      { type: "text", text: SYSTEM_INSTRUCTION, cache_control: { type: "ephemeral" } },
    ];

    // Acha o índice do último bloco cacheável (document ou image)
    // na última mensagem.
    let lastHeavyIdx = -1;
    for (let i = lastContent.length - 1; i >= 0; i--) {
      const t = lastContent[i].type;
      if (t === "document" || t === "image") {
        lastHeavyIdx = i;
        break;
      }
    }
    if (lastHeavyIdx >= 0) {
      lastContent[lastHeavyIdx] = {
        ...lastContent[lastHeavyIdx],
        cache_control: { type: "ephemeral" },
      };
    }

    // ---- Monta request, ativando thinking só onde for suportado ----
    const requestOptions = {
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: systemWithCache,
      messages: fullMessages,
    };
    if (supportsAdaptiveThinking(CLAUDE_MODEL)) {
      requestOptions.thinking = { type: "adaptive" };
    }

    const stream = await withRetry(() => anthropic.messages.stream(requestOptions));

    // Escuta deltas de texto e repassa.
    stream.on("text", (delta) => {
      if (delta) res.write(delta);
    });

    const finalMessage = await stream.finalMessage();

    const usage = finalMessage.usage || {};
    const inputUncached = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const totalInput = inputUncached + cacheRead + cacheWrite;
    const cacheHitPct = totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : "0.0";

    console.log("\n[AI CHAT] ---- Resposta do Claude ----");
    console.log(`[AI CHAT] Tokens de input (sem cache): ${inputUncached}`);
    console.log(`[AI CHAT] Tokens de output: ${usage.output_tokens ?? "?"}`);
    if (cacheRead) console.log(`[AI CHAT] Cache READ (10% custo): ${cacheRead} tokens`);
    if (cacheWrite) console.log(`[AI CHAT] Cache WRITE (1.25× custo): ${cacheWrite} tokens`);
    console.log(`[AI CHAT] Total input: ${totalInput} | Cache hit: ${cacheHitPct}%`);
    console.log(`[AI CHAT] Stop reason: ${finalMessage.stop_reason ?? "?"}`);
    console.log("========================================\n");

    res.end();
  } catch (error) {
    console.error("\n[AI CHAT] ❌ ERRO:", error);
    const status = error?.status || 500;
    let message = "Erro ao processar mensagem com IA.";
    if (status === 529 || status === 503) {
      message = "Servidor sobrecarregado. Tente novamente em 1 minuto.";
    } else if (status === 429) {
      message = "Limite de requisições excedido. Aguarde alguns minutos.";
    } else if (status === 401) {
      message = "Chave da API do Claude inválida ou ausente.";
    }

    if (!res.headersSent) {
      res.status(status).json({ error: message });
    } else {
      try {
        res.write(`\n[ERRO]: ${message}`);
        res.end();
      } catch { /* stream já encerrado */ }
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

// Schema JSON estrito para structured output do Claude.
function buildExtractSchema() {
  const properties = {};
  for (const field of EXTRACTABLE_FIELDS) {
    properties[field] = { type: "string" };
  }
  return {
    type: "object",
    properties,
    required: EXTRACTABLE_FIELDS,
    additionalProperties: false,
  };
}

const EXTRACT_SCHEMA = buildExtractSchema();

app.post("/ai/extract-fields", authCheck, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Conteúdo não fornecido" });
    }

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

    // Usa structured outputs do Claude — garante JSON válido aderente ao schema.
    const response = await withRetry(() =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        system: SYSTEM_INSTRUCTION,
        output_config: {
          format: {
            type: "json_schema",
            schema: EXTRACT_SCHEMA,
          },
        },
        messages: [{ role: "user", content: prompt }],
      })
    );

    // Extrai o texto da resposta (estará no formato JSON pelo schema).
    let rawText = "";
    for (const block of response.content || []) {
      if (block.type === "text" && block.text) rawText += block.text;
    }
    const cleaned = rawText.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");
    const fields = JSON.parse(cleaned);

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
  res.json({ status: "ok", model: CLAUDE_MODEL });
});

app.listen(PORT,  () => {
  console.log(`docx-converter rodando na porta ${PORT}`);
  console.log(`AI provider: Anthropic Claude (${CLAUDE_MODEL})`);
  if (!ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY não configurada — chamadas /ai/* irão falhar.");
  }
});

