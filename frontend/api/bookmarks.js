/*
 * Vercel Serverless Function: /api/bookmarks
 *
 * Stores word bookmarks (a source word + its translation) in MongoDB.
 * Bookmarks are scoped per anonymous browser via a clientId the frontend
 * generates and keeps in localStorage — there is no auth in this app.
 *
 *   GET    /api/bookmarks?clientId=abc         -> list a client's bookmarks
 *   POST   /api/bookmarks                      -> add    { clientId, source, target, sourceLang, targetLang }
 *   DELETE /api/bookmarks?id=<id>&clientId=abc -> remove one (scoped to the client)
 *
 * Requires MONGODB_URI. Optional: MONGODB_DB, MONGODB_BOOKMARKS_COLLECTION.
 */

import { MongoClient, ObjectId } from "mongodb";

const DB_NAME = process.env.MONGODB_DB || "indian_translator";
const COLLECTION =
  process.env.MONGODB_BOOKMARKS_COLLECTION || "bookmarks";

// Cache the client across invocations (serverless reuses the module scope).
// Stored on globalThis so hot reloads / multiple bundles share one pool.
let cached = globalThis.__mongoBookmarks;
if (!cached) {
  cached = globalThis.__mongoBookmarks = { client: null, promise: null };
}

async function getCollection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  if (!cached.promise) {
    cached.promise = new MongoClient(uri, {
      // Keep the pool small; serverless invocations are short-lived.
      maxPoolSize: 5,
    })
      .connect()
      .then((client) => {
        cached.client = client;
        return client;
      })
      .catch((error) => {
        // Reset so the next request can retry instead of reusing a dead promise.
        cached.promise = null;
        throw error;
      });
  }

  const client = await cached.promise;
  const collection = client.db(DB_NAME).collection(COLLECTION);

  // Idempotent: prevents duplicate bookmarks of the same word pair per client.
  await collection.createIndex(
    { clientId: 1, source: 1, target: 1, sourceLang: 1, targetLang: 1 },
    { unique: true }
  );

  return collection;
}

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export default async function handler(req, res) {
  try {
    const collection = await getCollection();

    if (req.method === "GET") {
      const clientId = req.query?.clientId;
      if (!isNonEmptyString(clientId)) {
        return res.status(400).json({ error: "clientId is required." });
      }

      const bookmarks = await collection
        .find({ clientId })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();

      return res.status(200).json({
        bookmarks: bookmarks.map((b) => ({
          id: b._id.toString(),
          source: b.source,
          target: b.target,
          sourceLang: b.sourceLang,
          targetLang: b.targetLang,
          createdAt: b.createdAt,
        })),
      });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const { clientId, source, target, sourceLang, targetLang } = body;

      if (!isNonEmptyString(clientId)) {
        return res.status(400).json({ error: "clientId is required." });
      }
      if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
        return res
          .status(400)
          .json({ error: "source and target are required." });
      }

      const doc = {
        clientId: clientId.trim(),
        source: source.trim(),
        target: target.trim(),
        sourceLang: isNonEmptyString(sourceLang) ? sourceLang.trim() : "",
        targetLang: isNonEmptyString(targetLang) ? targetLang.trim() : "",
        createdAt: new Date().toISOString(),
      };

      try {
        const result = await collection.insertOne(doc);
        return res.status(201).json({
          bookmark: { id: result.insertedId.toString(), ...doc },
        });
      } catch (error) {
        // Duplicate key: the pair is already bookmarked. Return the existing one.
        if (error?.code === 11000) {
          const existing = await collection.findOne({
            clientId: doc.clientId,
            source: doc.source,
            target: doc.target,
            sourceLang: doc.sourceLang,
            targetLang: doc.targetLang,
          });
          return res.status(200).json({
            bookmark: existing
              ? { id: existing._id.toString(), ...doc }
              : null,
            duplicate: true,
          });
        }
        throw error;
      }
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;
      const clientId = req.query?.clientId;

      if (!isNonEmptyString(id) || !isNonEmptyString(clientId)) {
        return res
          .status(400)
          .json({ error: "id and clientId are required." });
      }

      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch {
        return res.status(400).json({ error: "Invalid bookmark id." });
      }

      // Scope delete to the owning client so one browser can't delete another's.
      const result = await collection.deleteOne({ _id: objectId, clientId });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Bookmark not found." });
      }

      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("Bookmarks error:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Bookmarks request failed." });
  }
}
