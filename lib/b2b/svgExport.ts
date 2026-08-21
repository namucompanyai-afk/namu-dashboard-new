/**
 * SVG 문자열 → JPG 저장 (외부 라이브러리 없이 Image + canvas).
 * JPG 는 투명을 지원하지 않으므로 흰 배경을 먼저 칠하고 그린다.
 * 한글이 기본 폰트로 대체되어 깨지지 않도록 document.fonts.ready 를 기다린 뒤 렌더한다.
 */

/** 생성한 SVG 의 width/height 속성 (캔버스 크기 산정용) */
export function svgSize(svg: string): { w: number; h: number } {
  const m = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg)
  return { w: m ? Number(m[1]) : 1200, h: m ? Number(m[2]) : 900 }
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function downloadSvgAsJpg(
  svg: string,
  fileName: string,
  scale = 2,
  quality = 0.92,
): Promise<void> {
  try {
    await document.fonts?.ready
  } catch {
    /* 폰트 준비 실패는 무시하고 기본 폰트로 진행 */
  }
  const { w, h } = svgSize(svg)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('도면 이미지를 만들지 못했습니다.'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('캔버스를 사용할 수 없습니다.')
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const jpg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('JPG 변환에 실패했습니다.'))),
        'image/jpeg',
        quality,
      ),
    )
    saveBlob(jpg, fileName)
  } finally {
    URL.revokeObjectURL(url)
  }
}
