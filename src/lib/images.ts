export const MAX_IMAGE_EDGE = 1200;
export const IMAGE_QUALITY = 0.85;

function heicHint(file: File): string {
  if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    return ' (아이폰 HEIC 사진입니다. 아이폰 설정 → 카메라 → 형식에서 [호환성 우선]을 켜면 JPEG로 저장됩니다.)';
  }
  return '';
}

// 파일을 디코딩하여 캔버스 소스로 변환 (ImageBitmap 우선, 실패 시 Image 태그 폴백)
function decodeFile(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close?: () => void }> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error) => reject(err);
    if (typeof createImageBitmap === 'function') {
      createImageBitmap(file)
        .then((bmp) => {
          resolve({
            source: bmp,
            width: bmp.width,
            height: bmp.height,
            close: () => bmp.close(),
          });
        })
        .catch(() => {
          // ImageBitmap 미지원 형식(HEIC 등)은 Image 태그로 재시도
          const reader = new FileReader();
          reader.onload = () => {
            const img = new Image();
            img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () =>
              fail(new Error('이미지를 불러오지 못했습니다.' + heicHint(file)));
            img.src = reader.result as string;
          };
          reader.onerror = () => fail(new Error('파일을 읽지 못했습니다.'));
          reader.readAsDataURL(file);
        });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => fail(new Error('이미지를 불러오지 못했습니다.' + heicHint(file)));
      img.src = reader.result as string;
    };
    reader.onerror = () => fail(new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('이미지 파일만 등록할 수 있습니다.');
  }
  const { source, width, height, close } = await decodeFile(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('이미지를 처리할 수 없습니다.');
    }
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
    if (!dataUrl || dataUrl.length < 100) {
      throw new Error('이미지 변환에 실패했습니다.' + heicHint(file));
    }
    return dataUrl;
  } finally {
    if (close) close();
  }
}

// 여러 장을 순차적으로 압축 (모바일에서 동시 처리 시 메모리 부족 방지)
export async function compressImages(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<{ images: string[]; errors: string[] }> {
  const images: string[] = [];
  const errors: string[] = [];
  let done = 0;
  for (const file of files) {
    try {
      images.push(await compressImage(file));
    } catch (err: any) {
      errors.push(`${file.name || '사진'}: ${err?.message || '처리 실패'}`);
    }
    done += 1;
    if (onProgress) onProgress(done, files.length);
  }
  return { images, errors };
}

export function saveSafely<T>(saveFn: (value: T) => void, value: T): boolean {
  try {
    saveFn(value);
    return true;
  } catch {
    alert('저장 공간이 부족합니다. 사진 개수를 줄이거나 일부 사진을 삭제해주세요.');
    return false;
  }
}
