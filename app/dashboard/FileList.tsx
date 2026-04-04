'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface FileListProps {
  onFileSelect: (file: any) => void;
}

export default function FileList({ onFileSelect }: FileListProps) {
  const [files, setFiles] = useState<any[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function fetchFiles() {
    const { data, error } = await supabase
      .from('files')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) console.error("Error fetching files:", error);
    else setFiles(data || []);
  }

  useEffect(() => {
    fetchFiles();
  }, []);

  async function handleDelete(fileId: string, storagePath: string) {
    if (!confirm("Are you sure you want to delete this file?")) return;
    
    setDeletingId(fileId);
    try {
      // 1. Remove from Supabase Storage
      const { error: storageError } = await supabase.storage
        .from('files')
        .remove([storagePath]);

      if (storageError) throw storageError;

      // 2. Remove from Database (This will cascade delete document chunks)
      const { error: dbError } = await supabase
        .from('files')
        .delete()
        .eq('id', fileId);

      if (dbError) throw dbError;

      // 3. Refresh the list
      setFiles(files.filter(f => f.id !== fileId));
    } catch (err) {
      alert("Failed to delete file");
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {files.map((file) => (
        <div 
          key={file.id} 
          className="flex justify-between items-center p-3 bg-white border rounded shadow-sm hover:border-indigo-400 transition"
        >
          <div className="flex flex-col">
            <span className="font-medium text-gray-700 truncate max-w-[250px]">{file.name}</span>
            <span className="text-[10px] text-gray-400">{new Date(file.created_at).toLocaleDateString()}</span>
          </div>

          <div className="flex space-x-2">
            <button 
              onClick={() => onFileSelect(file)}
              className="px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-xs font-semibold"
            >
              Chat
            </button>
            <button 
              onClick={() => handleDelete(file.id, file.storage_path)}
              disabled={deletingId === file.id}
              className={`px-3 py-1 border border-red-200 text-red-600 rounded hover:bg-red-50 text-xs font-semibold ${
                deletingId === file.id ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {deletingId === file.id ? '...' : 'Delete'}
            </button>
          </div>
        </div>
      ))}
      
      {files.length === 0 && (
        <p className="text-gray-400 italic text-center py-4">No files found. Upload a PDF to begin.</p>
      )}
    </div>
  );
}