export interface ImageTile { x: number; y: number; width: number; height: number }
export function imageDetailTiles(width: number, height: number): ImageTile[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return [];
  if ((Math.max(width, height) <= 1568 && Math.ceil(width / 28) * Math.ceil(height / 28) <= 1568) || width * height > 40_000_000) return [];
  const side = 1024;
  const step = side - 64;
  const result: ImageTile[] = [];
  const positions = (length: number) => {
    const result = [0];
    while (result[result.length - 1] + side < length) result.push(result[result.length - 1] + step);
    return result;
  };
  for (const y of positions(height)) {
    for (const x of positions(width)) result.push({ x, y, width: Math.min(side, width - x), height: Math.min(side, height - y) });
  }
  return result.length <= 64 ? result : [];
}

/** Local PNG crops retain source pixels; 1024-square tiles fit standard vision limits. */
export async function createImageDetails(dataUrl: string, name: string, save: (name: string, bytes: number[]) => Promise<string>): Promise<string[]> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const tiles = imageDetailTiles(img.naturalWidth, img.naturalHeight);
  if (!tiles.length && (Math.max(img.naturalWidth, img.naturalHeight) > 1568 || Math.ceil(img.naturalWidth / 28) * Math.ceil(img.naturalHeight / 28) > 1568)) throw new Error('Image exceeds detail-crop budget');
  const details: string[] = [];
  for (const [i, tile] of tiles.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = tile.width;
    canvas.height = tile.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image detail canvas unavailable');
    context.drawImage(img, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
    const path = await save(`${name.replace(/\.[^.]+$/, '')}-detail-${i + 1}-x${tile.x}-y${tile.y}.png`, Array.from(new Uint8Array(await blob.arrayBuffer())));
    details.push(path);
    canvas.width = canvas.height = 1;
  }
  return details;
}
