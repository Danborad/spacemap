//go:build ignore

package main

import (
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"sort"
)

func main() {
	outDir := "."
	if len(os.Args) > 1 {
		outDir = os.Args[1]
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		panic(err)
	}

	writePNG(filepath.Join(outDir, "ICON.PNG"), renderIcon(64, false))
	writePNG(filepath.Join(outDir, "ICON_256.PNG"), renderIcon(256, false))
	writeGIF(filepath.Join(outDir, "spacemap.gif"), renderIcon(64, false))
	writeGIF(filepath.Join(outDir, "spacemap_80.gif"), renderIcon(80, false))
	writeGIF(filepath.Join(outDir, "spacemap_gray.gif"), renderIcon(64, true))
}

// samplePixel 在 64x64 逻辑画布坐标 (sx, sy) 采样背景与四色块颜色，返回是否落在主圆角矩形内
func samplePixel(sx, sy float64, grayscale bool) (r, g, b float64, inside bool) {
	if !insideRoundedRect(sx, sy, 0, 0, 64, 64, 64*0.24) {
		return 0, 0, 0, false
	}

	// 底板：深空蓝黑 #0f172a
	r, g, b = 15, 23, 42

	switch {
	case insideRoundedRect(sx, sy, 11, 11, 23, 23, 5.5):
		// 左上主块：纯白
		r, g, b = 255, 255, 255
	case insideRoundedRect(sx, sy, 37, 11, 16, 16, 5.0):
		// 右上点睛块：天蓝 (#38bdf8) -> 靛蓝 (#6366f1)
		t := math.Min(1, math.Max(0, ((sx-37)+(sy-11))/32.0))
		r = 56 + t*(99-56)
		g = 189 + t*(102-189)
		b = 248 + t*(241-248)
	case insideRoundedRect(sx, sy, 37, 30, 16, 23, 5.0):
		// 右下块：青碧 #2dd4bf (90% 混底色)
		alpha := 0.90
		r = 15*(1-alpha) + 45*alpha
		g = 23*(1-alpha) + 212*alpha
		b = 42*(1-alpha) + 191*alpha
	case insideRoundedRect(sx, sy, 11, 37, 23, 16, 5.0):
		// 左下块：柔白 45%
		alpha := 0.45
		r = 15*(1-alpha) + 255*alpha
		g = 23*(1-alpha) + 255*alpha
		b = 42*(1-alpha) + 255*alpha
	}

	if grayscale {
		gray := 0.299*r + 0.587*g + 0.114*b
		r, g, b = gray, gray, gray
	}
	return r, g, b, true
}

// renderIcon 使用 4x4 超采样抗锯齿渲染清晰平滑的图标
func renderIcon(size int, grayscale bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	scale := float64(size) / 64.0
	const ss = 4

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sumR, sumG, sumB float64
			var hits int
			for syi := 0; syi < ss; syi++ {
				for sxi := 0; sxi < ss; sxi++ {
					fx := float64(x) + (float64(sxi)+0.5)/float64(ss)
					fy := float64(y) + (float64(syi)+0.5)/float64(ss)
					r, g, b, inside := samplePixel(fx/scale, fy/scale, grayscale)
					if inside {
						sumR += r
						sumG += g
						sumB += b
						hits++
					}
				}
			}
			if hits == 0 {
				continue
			}
			a := uint8(math.Round(float64(hits) * 255.0 / float64(ss*ss)))
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(math.Round(sumR / float64(hits))),
				G: uint8(math.Round(sumG / float64(hits))),
				B: uint8(math.Round(sumB / float64(hits))),
				A: a,
			})
		}
	}
	return img
}

func insideRoundedRect(px, py, rx, ry, rw, rh, rad float64) bool {
	if px < rx || px > rx+rw || py < ry || py > ry+rh {
		return false
	}
	lx, ly := px-rx, py-ry
	if lx < rad && ly < rad {
		return math.Hypot(lx-rad, ly-rad) <= rad
	}
	if lx > rw-rad && ly < rad {
		return math.Hypot(lx-(rw-rad), ly-rad) <= rad
	}
	if lx < rad && ly > rh-rad {
		return math.Hypot(lx-rad, ly-(rh-rad)) <= rad
	}
	if lx > rw-rad && ly > rh-rad {
		return math.Hypot(lx-(rw-rad), ly-(rh-rad)) <= rad
	}
	return true
}

func writePNG(p string, img image.Image) {
	f, err := os.Create(p)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		panic(err)
	}
}

// writeGIF 基于图像实际高频颜色构建专属 256 色调色板并无抖动编码，彻底避免 Plan9 噪点
func writeGIF(p string, src *image.NRGBA) {
	b := src.Bounds()
	type colorCount struct {
		c     color.NRGBA
		count int
	}
	freq := make(map[color.NRGBA]int, 512)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			px := src.NRGBAAt(x, y)
			if px.A < 128 {
				continue
			}
			px.A = 255
			freq[px]++
		}
	}

	list := make([]colorCount, 0, len(freq))
	for c, cnt := range freq {
		list = append(list, colorCount{c: c, count: cnt})
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].count > list[j].count
	})

	pal := make(color.Palette, 1, 256)
	pal[0] = color.NRGBA{0, 0, 0, 0} // 透明索引 0
	for i := 0; i < len(list) && len(pal) < 256; i++ {
		pal = append(pal, list[i].c)
	}

	palImg := image.NewPaletted(b, pal)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			px := src.NRGBAAt(x, y)
			if px.A < 128 {
				palImg.SetColorIndex(x, y, 0)
				continue
			}
			px.A = 255
			// 在不含索引 0 透明色的不透明子调色板中找最近色（无 Floyd-Steinberg 抖动）
			idx := pal[1:].Index(px) + 1
			palImg.SetColorIndex(x, y, uint8(idx))
		}
	}

	// 确保满足 gif.Encode 对 draw.Image 无抖动的兼容
	_ = draw.Src

	f, err := os.Create(p)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := gif.EncodeAll(f, &gif.GIF{
		Image: []*image.Paletted{palImg},
		Delay: []int{0},
	}); err != nil {
		panic(err)
	}
}
