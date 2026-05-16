const fs = require('fs');
const path = 'c:\\Users\\BRUNO\\Documents\\FORMATURA PRO 2.0\\formatura-pro\\src\\views\\ScannerWorkspace.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Catalog Fixes
// Remove the sync with currentCatalog and set initial state to empty
content = content.replace('const [catalogName, setCatalogName] = useState(\'\');', 'const [catalogName, setCatalogName] = useState(\'\');');
// Find and remove the useEffect that syncs catalogName
content = content.replace(/useEffect\(\(\) => \{[\s\n\r]*if \(currentCatalog && !catalogName\) setCatalogName\(currentCatalog\);[\s\n\r]*return \(\) => \{[\s\n\r]*if \(pollRef\.current\) clearInterval\(pollRef\.current\);[\s\n\r]*if \(metricsPollRef\.current\) clearInterval\(metricsPollRef\.current\);[\s\n\r]*\};[\s\n\r]*\}, \[currentCatalog, catalogName\]\);/, 
    `useEffect(() => {
    return () => { 
      if (pollRef.current) clearInterval(pollRef.current); 
      if (metricsPollRef.current) clearInterval(metricsPollRef.current); 
    };
  }, []);`);

// Update the placeholder
content = content.replace('placeholder="Digite o nome para o novo catálogo..."', 'placeholder="Digite o nome do novo catálogo"');

// 2. Event Count Fixes
// Add state for status
content = content.replace('const [eventPhotosCount, setEventPhotosCount] = useState(0);', 
    'const [eventPhotosCount, setEventPhotosCount] = useState(0);\n  const [eventPhotosCountStatus, setEventPhotosCountStatus] = useState<\'none\' | \'loading\' | \'done\' | \'error\'>(\'none\');');

// Update useEffect for event count to respect recursive and raw options + status
const newEventEffect = `
  useEffect(() => {
    if (eventFolders.length === 0) {
      setEventPhotosCount(0);
      setEventPhotosCountStatus('none');
      return;
    }
    const fetchInfo = async () => {
      setEventPhotosCountStatus('loading');
      try {
        let total = 0;
        for (const path of eventFolders) {
          const res = await api.explorePhotos(path, { 
            recursive: recursiveEnabled, 
            limit: 0, 
            include_raw: rawEnabled 
          });
          total += res.total || 0;
        }
        setEventPhotosCount(total);
        setEventPhotosCountStatus('done');
      } catch (e) {
        console.error('Erro ao contar fotos de eventos:', e);
        setEventPhotosCountStatus('error');
      }
    };
    fetchInfo();
  }, [eventFolders, recursiveEnabled, rawEnabled]);
`;

content = content.replace(/useEffect\(\(\) => \{[\s\n\r]*if \(eventFolders\.length === 0\) \{[\s\n\r]*setEventPhotosCount\(0\);[\s\n\r]*return;[\s\n\r]*\}[\s\n\r]*const fetchInfo = async \(\) => \{[\s\n\r]*try \{[\s\n\r]*let total = 0;[\s\n\r]*for \(const path of eventFolders\) \{[\s\n\r]*const res = await api\.explorePhotos\(path, \{ recursive: true, limit: 0, include_raw: true \}\);[\s\n\r]*total \+= res\.total \|\| 0;[\s\n\r]*\}[\s\n\r]*setEventPhotosCount\(total\);[\s\n\r]*\} catch \(e\) \{[\s\n\r]*console\.error\('Erro ao contar fotos de eventos:', e\);[\s\n\r]*\}[\s\n\r]*\};[\s\n\r]*fetchInfo\(\);[\s\n\r]*\}, \[eventFolders\]\);/, newEventEffect);

// Update Event UI Section
const newEventUI = `
                  {eventPhotosCountStatus === 'loading' && (
                    <div className={styles.refStats}>
                      <LoaderCircle size={10} className={styles.spin} />
                      <span>Contando imagens...</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'error' && (
                    <div className={styles.refStats} style={{ color: '#ef4444' }}>
                      <AlertTriangle size={10} />
                      <span>Não foi possível contar imagens</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'done' && eventPhotosCount > 0 && (
                    <div className={styles.refStats}>
                      <ImageIcon size={10} />
                      <span>{eventPhotosCount.toLocaleString('pt-BR')} imagens detectadas</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'none' && (
                    <div className={styles.refStats} style={{ color: '#5a6577' }}>
                      <span>Nenhuma pasta selecionada</span>
                    </div>
                  )}
`;

content = content.replace(/\{eventPhotosCount > 0 && \([\s\S]+?<\/div>\s+\)\}/, newEventUI);

fs.writeFileSync(path, content);
console.log('Final polish complete');
