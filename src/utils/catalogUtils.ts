export function autoCatalogName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Catalogo_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}
