"use client" // <--- Important: This tells Next.js this part is interactive
import { useState } from 'react'

export default function ChatBox({ fileId }: { fileId: string }) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChat = async () => {
    if (!query) return;
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: query, file_id: fileId }),
      });
      const data = await res.json();
      setAnswer(data.text);
    } catch (err) {
      console.error("Chat failed", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded-lg bg-white shadow-sm mt-6">
      <h3 className="text-lg font-bold mb-2">Chat with your PDF</h3>
      <div className="flex gap-2">
        <input 
          className="flex-1 border p-2 rounded text-black"
          placeholder="Ask a question..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button 
          onClick={handleChat}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {loading ? "Thinking..." : "Ask"}
        </button>
      </div>
      {answer && (
        <div className="mt-4 p-3 bg-gray-50 rounded border-l-4 border-blue-500 text-gray-800">
          <strong>AI Answer:</strong>
          <p className="mt-1">{answer}</p>
        </div>
      )}
    </div>
  );
}