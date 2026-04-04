'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Upload, Loader2 } from 'lucide-react';

export default function FileUpload() {
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      if (!e.target.files || e.target.files.length === 0) return;
      
      const file = e.target.files[0];
      setUploading(true);
      console.log("1. Starting Upload for:", file.name);

      // 1. Upload file to Supabase Storage
      const fileExt = file.name.split('.').pop();
      const fileName = `${Math.random()}.${fileExt}`;
      const filePath = `${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('user-files')
        .upload(filePath, file);

      if (uploadError) throw uploadError;
      console.log("2. Upload to Storage Successful");

      // 2. Save metadata to Database
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("No user found");

      const { data: dbData, error: dbError } = await supabase
        .from('files')
        .insert({
          name: file.name,
          storage_path: filePath,
          type: file.type,
          size: file.size,
          user_id: user.id
        })
        .select()
        .single();

      if (dbError) throw dbError;
      console.log("3. Database Insert Successful", dbData);

      // 3. TRIGGER THE AI BRAIN (Ingest API)
      console.log("4. Calling Ingest API...");
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: dbData.id,
          storage_path: filePath
        })
      });

      const result = await response.json();
      console.log("5. API Response:", result);

      if (!response.ok) {
        throw new Error(result.error || "API Failed");
      }

      // 4. Success! Notify the user and refresh the list
      alert('Upload & AI Processing Complete!');
      
      // ✨ THIS IS THE NEW LINE THAT REFRESHES THE LIST AUTOMATICALLY ✨
      window.dispatchEvent(new Event('file-uploaded'));

    } catch (error: any) {
      console.error('Upload failed:', error);
      alert('Error: ' + error.message);
    } finally {
      setUploading(false);
      // Reset the input so you can upload the same file again if needed
      e.target.value = '';
    }
  };

  return (
    <div className="p-8 border-2 border-dashed border-gray-300 rounded-xl bg-gray-50 text-center hover:border-blue-500 hover:bg-blue-50 transition-all cursor-pointer group">
      <input
        type="file"
        id="file-upload"
        accept=".pdf"
        onChange={handleUpload}
        disabled={uploading}
        className="hidden"
      />
      <label 
        htmlFor="file-upload" 
        className="cursor-pointer flex flex-col items-center justify-center space-y-4 w-full h-full"
      >
        <div className={`p-4 rounded-full ${uploading ? 'bg-gray-200' : 'bg-blue-100 group-hover:bg-blue-200'} transition-colors`}>
            {uploading ? (
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            ) : (
                <Upload className="w-8 h-8 text-blue-600" />
            )}
        </div>
        
        <div className="space-y-1">
            <span className="text-lg font-medium text-gray-700 block">
            {uploading ? 'Processing AI...' : 'Click to Upload PDF'}
            </span>
            <span className="text-sm text-gray-400 block">
            Supports PDF up to 10MB
            </span>
        </div>
      </label>
    </div>
  );
}