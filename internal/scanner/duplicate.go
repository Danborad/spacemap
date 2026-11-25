package scanner

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"os"
	"sort"

	"spacemap/internal/db"
)

const partialSampleSize = 64 * 1024

// DuplicateGroup 表示一组完全相同内容的重复文件。
type DuplicateGroup struct {
	Hash             string        `json:"hash"`
	Size             int64         `json:"size"`
	Count            int           `json:"count"`
	ReclaimableBytes int64         `json:"reclaimableBytes"`
	Files            []db.FileItem `json:"files"`
}

// DuplicateReport 汇总重复文件检测结果。
type DuplicateReport struct {
	ScanID           int64            `json:"scanId"`
	MinSize          int64            `json:"minSize"`
	GroupCount       int              `json:"groupCount"`
	DuplicateFiles   int              `json:"duplicateFiles"`
	ReclaimableBytes int64            `json:"reclaimableBytes"`
	Groups           []DuplicateGroup `json:"groups"`
}

// FindDuplicates 使用三阶段策略精确查重（大小预筛 -> 首尾 64KB 哈希 -> 全量 SHA-256），
// 并且自动排除共享相同 inode 的硬链接（因为硬链接不额外占用空间）。
func FindDuplicates(ctx context.Context, database *db.DB, scanID int64, minSize int64) (*DuplicateReport, error) {
	if minSize < 1 {
		minSize = 1
	}
	candidates, err := database.GetDuplicateSizeCandidates(scanID, minSize)
	if err != nil {
		return nil, err
	}

	// 按文件大小分桶
	bySize := make(map[int64][]db.FileItem)
	for _, f := range candidates {
		bySize[f.Size] = append(bySize[f.Size], f)
	}

	// 第一阶段：计算局部指纹（大小 + 首尾 64KB）
	byPartial := make(map[string][]db.FileItem)
	for size, list := range bySize {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// 如果该大小分桶内所有文件都指向同一个 inode（硬链接），直接跳过
		if allSameInode(list) {
			continue
		}
		for _, f := range list {
			pHash := f.PartialHash
			if pHash == "" {
				h, err := computePartialHash(f.Path, size)
				if err != nil {
					continue // 文件可能已被外部移动或无权限
				}
				pHash = h
				f.PartialHash = pHash
				_ = database.UpdateFileHashes(f.ID, f.PartialHash, f.FullHash)
			}
			byPartial[pHash] = append(byPartial[pHash], f)
		}
	}

	// 第二阶段：对局部指纹碰撞的文件计算全量 SHA-256
	byFull := make(map[string][]db.FileItem)
	for _, list := range byPartial {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if len(list) < 2 || allSameInode(list) {
			continue
		}
		for _, f := range list {
			fHash := f.FullHash
			if fHash == "" {
				h, err := computeFullHash(ctx, f.Path)
				if err != nil {
					continue
				}
				fHash = h
				f.FullHash = fHash
				_ = database.UpdateFileHashes(f.ID, f.PartialHash, f.FullHash)
			}
			byFull[fHash] = append(byFull[fHash], f)
		}
	}

	// 第三阶段：整理重复组并排除单组内仅由同一 inode 构成的情况
	var groups []DuplicateGroup
	var totalReclaim int64
	var totalFiles int

	for fullHash, list := range byFull {
		if len(list) < 2 || allSameInode(list) {
			continue
		}
		// 统计组内不重复的 inode 数量，用于准确估算可释放空间
		distinctInodes := countDistinctPhysicalCopies(list)
		if distinctInodes < 2 {
			continue
		}
		// 按修改时间从旧到新排，方便前端决定保留最旧或最新
		sort.Slice(list, func(i, j int) bool {
			if list[i].Mtime == list[j].Mtime {
				return list[i].Path < list[j].Path
			}
			return list[i].Mtime < list[j].Mtime
		})
		reclaimable := int64(distinctInodes-1) * list[0].Size
		totalReclaim += reclaimable
		totalFiles += len(list)
		groups = append(groups, DuplicateGroup{
			Hash:             fullHash,
			Size:             list[0].Size,
			Count:            len(list),
			ReclaimableBytes: reclaimable,
			Files:            list,
		})
	}

	sort.Slice(groups, func(i, j int) bool {
		if groups[i].ReclaimableBytes == groups[j].ReclaimableBytes {
			return groups[i].Size > groups[j].Size
		}
		return groups[i].ReclaimableBytes > groups[j].ReclaimableBytes
	})

	if groups == nil {
		groups = []DuplicateGroup{}
	}

	return &DuplicateReport{
		ScanID:           scanID,
		MinSize:          minSize,
		GroupCount:       len(groups),
		DuplicateFiles:   totalFiles,
		ReclaimableBytes: totalReclaim,
		Groups:           groups,
	}, nil
}

func allSameInode(list []db.FileItem) bool {
	if len(list) < 2 {
		return true
	}
	first := list[0].InodeKey
	if first == "" {
		return false
	}
	for _, it := range list[1:] {
		if it.InodeKey == "" || it.InodeKey != first {
			return false
		}
	}
	return true
}

func countDistinctPhysicalCopies(list []db.FileItem) int {
	seen := make(map[string]struct{})
	count := 0
	for _, it := range list {
		if it.InodeKey == "" {
			count++
			continue
		}
		if _, ok := seen[it.InodeKey]; !ok {
			seen[it.InodeKey] = struct{}{}
			count++
		}
	}
	return count
}

func computePartialHash(filePath string, expectedSize int64) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	actualSize := info.Size()
	if actualSize != expectedSize {
		expectedSize = actualSize
	}

	h := sha256.New()
	var sizeBuf [8]byte
	binary.LittleEndian.PutUint64(sizeBuf[:], uint64(expectedSize))
	_, _ = h.Write(sizeBuf[:])

	buf := make([]byte, partialSampleSize)
	if expectedSize <= partialSampleSize*2 {
		if _, err := io.CopyBuffer(h, f, buf); err != nil {
			return "", err
		}
		return hex.EncodeToString(h.Sum(nil)), nil
	}

	if _, err := io.ReadFull(f, buf); err != nil {
		return "", err
	}
	_, _ = h.Write(buf)

	if _, err := f.Seek(expectedSize-partialSampleSize, io.SeekStart); err != nil {
		return "", err
	}
	if _, err := io.ReadFull(f, buf); err != nil {
		return "", err
	}
	_, _ = h.Write(buf)
	return hex.EncodeToString(h.Sum(nil)), nil
}

func computeFullHash(ctx context.Context, filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	buf := make([]byte, 256*1024)
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		n, err := f.Read(buf)
		if n > 0 {
			_, _ = h.Write(buf[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
