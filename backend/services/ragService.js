import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { QdrantVectorStore } from "@langchain/qdrant";
import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";

dotenv.config();


const CONFIG = {
  // Retrieval
  retrievalK: parseInt(process.env.RETRIEVAL_K) || 5,

  // Token budget for the context. 
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS) || 8000,

  // Corrective RAG (default ON) and HyDE (default OFF — costs 1 extra request).
  enableCorrective: process.env.ENABLE_CORRECTIVE_RAG !== "false",
  enableHyDE: process.env.ENABLE_HYDE === "true",

  // How many times we are allowed to rewrite-and-retry when retrieval is bad.
  maxRetries: parseInt(process.env.MAX_CORRECTION_RETRIES) || 1,

  relevanceHigh: parseFloat(process.env.RELEVANCE_HIGH) || 0.5,
  relevanceLow: parseFloat(process.env.RELEVANCE_LOW) || 0.15,
};

const getEmbeddings = () => {
  return new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });
};

const getVectorStore = async (embeddings, collectionName) => {
  return await QdrantVectorStore.fromExistingCollection(embeddings, {
    url: process.env.QDRANT_URL || "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY,
    collectionName: collectionName || process.env.COLLECTION_NAME || "notebooklm_rag",
  });
};

const getLLM = (temperature = 0.1) => {
  return new ChatOpenAI({
    model: process.env.MODEL || "llama-3.3-70b-versatile",
    apiKey: process.env.API_KEY,
    configuration: { baseURL: process.env.BASE_URL },
    temperature,
  });
};


const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);


const buildContext = (chunks, maxTokens) => {
  const parts = [];
  let used = 0;
  for (const chunk of chunks) {
    const text = chunk.pageContent;
    const cost = estimateTokens(text);
    if (used + cost > maxTokens) break;
    parts.push(text);
    used += cost;
  }
  return { contextText: parts.join("\n\n---\n\n"), usedChunks: parts.length, usedTokens: used };
};


const safeInvoke = async (llm, messages) => {
  try {
    return await llm.invoke(messages);
  } catch (error) {
    if (error?.status === 429 || error?.message?.includes("429")) {
      const rl = new Error("RateLimitExceeded");
      rl.isRateLimit = true;
      throw rl;
    }
    throw error;
  }
};


const extractText = (response) => {
  if (typeof response.content === "string") {
    return response.content
      .replace(/<(?:thought|think)>[\s\S]*?<\/(?:thought|think)>/gi, "")
      .trim();
  }
  if (Array.isArray(response.content)) {
    const block = response.content.find((b) => b.type === "text" || b.text);
    return block?.text || JSON.stringify(response.content);
  }
  return String(response.content ?? "");
};


export const processAndStoreDocument = async (filePath, mimeType, collectionName) => {
  let loader;

  if (mimeType === "application/pdf") {
    loader = new PDFLoader(filePath);
  } else if (mimeType === "text/csv") {
    loader = new CSVLoader(filePath);
  } else if (mimeType === "text/plain") {
    loader = {
      load: async () => {
        const fs = await import("fs/promises");
        const text = await fs.readFile(filePath, "utf8");
        return [{ pageContent: text, metadata: { source: filePath } }];
      },
    };
  } else {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  const rawDocs = await loader.load();
  console.log(`Loaded ${rawDocs.length} pages/rows.`);

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks = await textSplitter.splitDocuments(rawDocs);
  console.log(`Split into ${chunks.length} chunks.`);

  const embeddings = getEmbeddings();
  const batchSize = 500;
  let vectorStore;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(
      `Embedding & Indexing chunks ${i + 1} to ${Math.min(i + batchSize, chunks.length)} out of ${chunks.length}...`
    );

    if (!vectorStore) {
      vectorStore = await QdrantVectorStore.fromDocuments(batch, embeddings, {
        url: process.env.QDRANT_URL || "http://localhost:6333",
        apiKey: process.env.QDRANT_API_KEY,
        collectionName: collectionName || process.env.COLLECTION_NAME || "notebooklm_rag",
      });
    } else {
      await vectorStore.addDocuments(batch);
    }
  }

  console.log("Vector DB indexing complete.");
};


const generateHyDE = async (query) => {
  const llm = getLLM(0.3);
  const res = await safeInvoke(llm, [
    [
      "system",
      "You are helping a search system. Write a short, factual hypothetical passage (2-3 sentences) that would directly answer the user's question, as if it came from a reference document. Do not say you are unsure; just write a plausible passage.",
    ],
    ["human", query],
  ]);
  return extractText(res);
};


const judgeRelevance = async (query, chunks) => {
  if (!chunks.length) return { verdict: "INCORRECT", reason: "No chunks retrieved." };

  const llm = getLLM(0);
  // Truncate each chunk for the judge so the grading call stays cheap.
  const preview = chunks
    .map((c, i) => `[Chunk ${i + 1}]\n${c.pageContent.slice(0, 500)}`)
    .join("\n\n");

  const res = await safeInvoke(llm, [
    [
      "system",
      `You are a strict retrieval grader for a RAG system. Decide if the CONTEXT contains enough information to answer the QUESTION.
Respond with ONLY a compact JSON object, no prose:
{"verdict":"CORRECT|PARTIAL|INCORRECT","reason":"<max 12 words>"}
- CORRECT: context clearly answers the question.
- PARTIAL: context is related but incomplete.
- INCORRECT: context is unrelated / cannot answer.`,
    ],
    ["human", `QUESTION:\n${query}\n\nCONTEXT:\n${preview}`],
  ]);

  const raw = extractText(res);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const verdict = ["CORRECT", "PARTIAL", "INCORRECT"].includes(parsed.verdict)
      ? parsed.verdict
      : "PARTIAL";
    return { verdict, reason: parsed.reason || "" };
  } catch {
    // If the judge misbehaves, fail safe to PARTIAL so we still try to answer.
    return { verdict: "PARTIAL", reason: "Grader output unparseable; proceeding." };
  }
};


const rewriteQuery = async (query, reason) => {
  const llm = getLLM(0.3);
  const res = await safeInvoke(llm, [
    [
      "system",
      "Rewrite the user's question into a single, self-contained search query that maximizes document retrieval recall. Expand abbreviations, add likely synonyms/keywords, remove chit-chat. Output ONLY the rewritten query, nothing else.",
    ],
    ["human", `Original question: ${query}\nWhy retrieval failed: ${reason || "weak match"}`],
  ]);
  return extractText(res).replace(/^["']|["']$/g, "").trim() || query;
};


const retrieve = async (vectorStore, queryText, k) => {
  const scored = await vectorStore.similaritySearchWithScore(queryText, k);
  const chunks = scored.map(([doc]) => doc);
  const topScore = scored.length ? Math.max(...scored.map(([, s]) => s)) : 0;
  return { chunks, topScore };
};

const gradeRetrieval = async (query, chunks, topScore) => {
  if (!chunks.length) {
    return { verdict: "INCORRECT", reason: "No chunks retrieved.", usedJudge: false };
  }
  if (topScore >= CONFIG.relevanceHigh) {
    return {
      verdict: "CORRECT",
      reason: `High similarity (${topScore.toFixed(2)}) — judge skipped.`,
      usedJudge: false,
    };
  }
  if (topScore <= CONFIG.relevanceLow) {
    return {
      verdict: "INCORRECT",
      reason: `Low similarity (${topScore.toFixed(2)}) — judge skipped.`,
      usedJudge: false,
    };
  }
  // Grey zone: spend one LLM request to grade it properly.
  const judged = await judgeRelevance(query, chunks);
  return { ...judged, usedJudge: true };
};


export const generateAnswer = async (userQuery, collectionName) => {
  const embeddings = getEmbeddings();
  const vectorStore = await getVectorStore(embeddings, collectionName);

  const trace = [];
  const k = CONFIG.retrievalK;

  // ---- Step 1: choose what to embed (query, or HyDE document) ----
  let searchText = userQuery;
  if (CONFIG.enableHyDE) {
    const hyde = await generateHyDE(userQuery);
    searchText = hyde;
    trace.push({ step: "HyDE", detail: `Generated hypothetical passage and embedded it instead of the raw query.` });
  }

  // ---- Step 2: initial retrieval (with scores) ----
  let { chunks, topScore } = await retrieve(vectorStore, searchText, k);
  trace.push({
    step: "Retrieve",
    detail: `${chunks.length} chunks (k=${k}), top score ${topScore.toFixed(2)}.`,
  });

  // ---- Step 3: corrective loop (grade -> rewrite -> retrieve) ----
  if (CONFIG.enableCorrective) {
    let attempt = 0;
    let { verdict, reason, usedJudge } = await gradeRetrieval(userQuery, chunks, topScore);
    trace.push({
      step: usedJudge ? "Judge (LLM)" : "Grade (score)",
      detail: `Verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
    });

    while (verdict !== "CORRECT" && attempt < CONFIG.maxRetries) {
      attempt++;
      const rewritten = await rewriteQuery(userQuery, reason);
      trace.push({ step: `Rewrite #${attempt}`, detail: `New query: "${rewritten}"` });

      const retry = await retrieve(vectorStore, rewritten, k);
      trace.push({
        step: `Retrieve #${attempt + 1}`,
        detail: `${retry.chunks.length} chunks, top score ${retry.topScore.toFixed(2)}.`,
      });

      // Merge + de-duplicate so we keep the best of both passes.
      const seen = new Set(chunks.map((c) => c.pageContent));
      for (const c of retry.chunks) {
        if (!seen.has(c.pageContent)) {
          chunks.push(c);
          seen.add(c.pageContent);
        }
      }

      const regraded = await gradeRetrieval(userQuery, retry.chunks, retry.topScore);
      verdict = regraded.verdict;
      reason = regraded.reason;
      trace.push({
        step: regraded.usedJudge ? `Judge #${attempt + 1} (LLM)` : `Grade #${attempt + 1} (score)`,
        detail: `Verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
      });
    }

    // If still nothing usable, return a grounded "not found" without burning a
    // generation call on hopeless context.
    if (verdict === "INCORRECT") {
      trace.push({ step: "Decision", detail: "Retrieval failed after correction → grounded fallback." });
      return {
        answer:
          "I cannot find the answer to this question in the provided document.",
        trace,
      };
    }
  }

  // ---- Step 4: token-budgeted context (TPM safety) ----
  const { contextText, usedChunks, usedTokens } = buildContext(chunks, CONFIG.maxContextTokens);
  trace.push({
    step: "Context",
    detail: `Using ${usedChunks}/${chunks.length} chunks (~${usedTokens} tokens, cap ${CONFIG.maxContextTokens}).`,
  });

  // ---- Step 5: grounded generation ----
  const llm = getLLM(0.1);
  const systemPrompt = `You are an AI Assistant that behaves like Google NotebookLM.
Your job is to answer the user's query based ONLY on the provided context.

Rule:
- ONLY answer based on the available context.
- If the answer is not contained in the context, say "I cannot find the answer to this question in the provided document."
- Do not hallucinate or use external knowledge.

Context:
${contextText}`;

  const response = await safeInvoke(llm, [
    ["system", systemPrompt],
    ["human", userQuery],
  ]);

  const finalAnswer = extractText(response);
  trace.push({ step: "Answer", detail: "Generated grounded answer from final context." });

  return { answer: finalAnswer, trace };
};
