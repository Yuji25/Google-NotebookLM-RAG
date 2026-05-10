import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { QdrantVectorStore } from "@langchain/qdrant";
import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";

dotenv.config();

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
      }
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
    console.log(`Embedding & Indexing chunks ${i + 1} to ${Math.min(i + batchSize, chunks.length)} out of ${chunks.length}...`);
    
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

export const generateAnswer = async (userQuery, collectionName) => {

  const embeddings = getEmbeddings();
  const vectorStore = await getVectorStore(embeddings, collectionName);


  const retriever = vectorStore.asRetriever({
    k: 4, 
  });

  const searchedChunks = await retriever.invoke(userQuery);
  console.log(`Retrieved ${searchedChunks.length} relevant chunks.`);


  const llm = new ChatOpenAI({
    model: process.env.MODEL || "gemini-2.5-flash",
    apiKey: process.env.API_KEY,
    configuration: {
      baseURL: process.env.BASE_URL,
    },
    temperature: 0.1, 
  });

  const contextText = searchedChunks.map(chunk => chunk.pageContent).join("\n\n---\n\n");

  const systemPrompt = `You are an AI Assistant that behaves like Google NotebookLM.
Your job is to answer the user's query based ONLY on the provided context.

Rule:
- ONLY answer based on the available context.
- If the answer is not contained in the context, say "I cannot find the answer to this question in the provided document."
- Do not hallucinate or use external knowledge.

Context:
${contextText}`;

  let response;
  try {
    response = await llm.invoke([
      ["system", systemPrompt],
      ["human", userQuery]
    ]);
  } catch (error) {
    if (error?.status === 429 || error?.message?.includes("429")) {
      const rateLimitError = new Error("RateLimitExceeded");
      rateLimitError.isRateLimit = true;
      throw rateLimitError;
    }
    throw error;
  }

  let finalAnswer = "";
  if (typeof response.content === "string") {
    finalAnswer = response.content.replace(/<(?:thought|think)>[\s\S]*?<\/(?:thought|think)>/gi, "").trim();
  } else if (Array.isArray(response.content)) {
    const textBlock = response.content.find(block => block.type === "text" || block.text);
    if (textBlock && textBlock.text) {
      finalAnswer = textBlock.text;
    } else {
      finalAnswer = JSON.stringify(response.content);
    }
  }

  return finalAnswer;
};
