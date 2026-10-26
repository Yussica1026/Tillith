export async function prepareAttachment(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 2 * 1024 * 1024) return file;
  if (file.size > 32 * 1024 * 1024) throw new Error('这张图片超过 32 MB，请先缩小后再上传。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('这张图片无法读取，请换一张 JPG、PNG 或 WebP 图片。'); }
  try {
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.86));
    if (!blob || blob.size >= file.size) return file;
    const extension = blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + extension, { type: blob.type, lastModified: file.lastModified });
  } finally { bitmap.close(); }
}
