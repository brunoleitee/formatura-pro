interface FolderTreeProps {
  subfolders: string[];
  selectedSubfolder: string | null;
  onSelectSubfolder: (subfolder: string | null) => void;
}

export function FolderTree({ subfolders, selectedSubfolder, onSelectSubfolder }: FolderTreeProps) {
  if (subfolders.length === 0) return null;

  return (
    <div className="subfolder-filters">
      <button
        className={`subfolder-btn ${selectedSubfolder === null ? 'active' : ''}`}
        onClick={() => onSelectSubfolder(null)}
      >
        Todas as pastas
      </button>
      {subfolders.map((folder) => (
        <button
          key={folder}
          className={`subfolder-btn ${selectedSubfolder === folder ? 'active' : ''}`}
          onClick={() => onSelectSubfolder(folder)}
        >
          {folder}
        </button>
      ))}
    </div>
  );
}
