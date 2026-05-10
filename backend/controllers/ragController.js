import { processAndStoreDocument, generateAnswer } from "../services/ragService.js";
import fs from "fs";

export const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;
    const fileName = req.file.originalname;

    console.log(`Processing file: ${fileName} (${mimeType})`);

    let collectionName = fileName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();

    collectionName = `${collectionName}_${Date.now()}`;

    await processAndStoreDocument(filePath, mimeType, collectionName);

    fs.unlinkSync(filePath);

    res.status(200).json({
      success: true,
      message: "Document successfully indexed and ready for queries.",
      collectionName: collectionName,
    });
  } catch (error) {
    console.error("Error in uploadDocument:", error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({
      success: false,
      error: "An error occurred while processing the document.",
      details: error.message,
    });
  }
};

export const queryDocument = async (req, res) => {
  try {
    const { query, collectionName } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }
    if (!collectionName) {
      return res.status(400).json({ error: "collectionName is required. Please provide the collectionName from the upload response." });
    }

    console.log(`Received query: ${query} for collection: ${collectionName}`);

    const answer = await generateAnswer(query, collectionName);

    res.status(200).json({
      success: true,
      query: query,
      answer: answer,
    });
  } catch (error) {
    console.error("Error in queryDocument:", error);

    if (error.isRateLimit) {
      return res.status(429).json({
        success: false,
        error: "You have reached the API rate limit. Please wait 1 minute and try again.",
      });
    }

    res.status(500).json({
      success: false,
      error: "An error occurred while generating the answer.",
      details: error.stack,
    });
  }
};
