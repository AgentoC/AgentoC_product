//go:build windows

package safedelete

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// CapturedTree is an experimental snapshot of open handles, not an approval
// capability. The caller must authorize the workspace and request separately.
type CapturedTree struct {
	held     []*Pinned
	order    []*Pinned
	consumed bool
}

// CaptureForest validates every independent target before any deletion. It
// shares the same handle and size bounds as a single captured tree.
func CaptureForest(ctx context.Context, workspace string, relatives []string) (_ *CapturedTree, err error) {
	if len(relatives) == 0 || len(relatives) > 32 {
		return nil, errors.New("target count is invalid")
	}
	seen := make([]string, 0, len(relatives))
	forest := &CapturedTree{}
	defer func() {
		if err != nil {
			forest.Close()
		}
	}()
	for _, relative := range relatives {
		clean := strings.ToLower(filepath.Clean(relative))
		for _, other := range seen {
			if clean == other || strings.HasPrefix(clean, other+`\`) || strings.HasPrefix(other, clean+`\`) {
				return nil, errors.New("overlapping targets are not supported")
			}
		}
		seen = append(seen, clean)
		tree, captureErr := CaptureTree(ctx, workspace, relative, false)
		if captureErr != nil {
			return nil, captureErr
		}
		forest.held = append(forest.held, tree.held...)
		forest.order = append(forest.order, tree.order...)
		tree.held = nil
		tree.order = nil
		tree.consumed = true
		if len(forest.held) > 1024 {
			return nil, errors.New("targets exceed safety limits")
		}
	}
	return forest, nil
}

// CaptureTree pins a literal relative subtree without performing deletions.
// contentsOnly leaves the named directory itself in place (for a trailing *).
func CaptureTree(ctx context.Context, workspace, relative string, contentsOnly bool) (_ *CapturedTree, err error) {
	if ctx == nil {
		return nil, errors.New("context required")
	}
	if relative == "" || strings.HasPrefix(relative, `\`) || strings.HasPrefix(relative, "/") || strings.Contains(relative, ":") {
		return nil, errors.New("relative target required")
	}
	parts := strings.FieldsFunc(relative, func(r rune) bool { return r == '\\' || r == '/' })
	if len(parts) == 0 || len(parts) > 64 {
		return nil, errors.New("target depth is invalid")
	}
	for _, part := range parts {
		if part == "." || part == ".." {
			return nil, errors.New("relative traversal is not allowed")
		}
	}
	tree := &CapturedTree{}
	defer func() {
		if err != nil {
			tree.Close()
		}
	}()
	root, err := OpenWorkspace(workspace)
	if err != nil {
		return nil, err
	}
	tree.held = append(tree.held, root)
	current := root
	for index, part := range parts {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		current, err = current.openChild(part, index == len(parts)-1 && !contentsOnly)
		if err != nil {
			return nil, err
		}
		tree.held = append(tree.held, current)
	}
	if contentsOnly && !current.directory {
		return nil, errors.New("contents target is not a directory")
	}
	if err = tree.captureNode(ctx, current, 0, !contentsOnly); err != nil {
		return nil, err
	}
	return tree, nil
}

func (tree *CapturedTree) captureNode(ctx context.Context, current *Pinned, depth int, include bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if depth > 64 || len(tree.held) > 1024 {
		return errors.New("tree exceeds safety limits")
	}
	if current.directory {
		entries, err := current.snapshotChildren()
		if err != nil {
			return err
		}
		if len(tree.held)+len(entries) > 1024 {
			return errors.New("tree exceeds safety limits")
		}
		for _, entry := range entries {
			if err = ctx.Err(); err != nil {
				return err
			}
			child, openErr := current.openListedChild(entry)
			if openErr != nil {
				return openErr
			}
			tree.held = append(tree.held, child)
			if err = tree.captureNode(ctx, child, depth+1, true); err != nil {
				return err
			}
		}
	}
	if include {
		tree.order = append(tree.order, current)
	}
	return nil
}

// Commit removes only captured handles in postorder. If a directory gained a
// new child, its own removal fails; the new child is never traversed or deleted.
// Count reports already-completed deletions when a later operation fails.
func (tree *CapturedTree) Commit(ctx context.Context) (count int, err error) {
	return tree.CommitWithOptions(ctx, false)
}

// force permits removing a read-only item through the same pinned handle;
// unsupported filesystems return an error rather than changing attributes.
func (tree *CapturedTree) CommitWithOptions(ctx context.Context, force bool) (count int, err error) {
	if tree == nil || tree.consumed || ctx == nil {
		return 0, errors.New("capture is unavailable")
	}
	tree.consumed = true
	defer tree.Close()
	for _, entry := range tree.order {
		if err = entry.check(); err != nil {
			return 0, err
		}
		if !force && entry.attributes&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM|windows.FILE_ATTRIBUTE_READONLY) != 0 {
			return 0, errors.New("hidden, system or read-only targets require force")
		}
	}
	for _, entry := range tree.order {
		if err = ctx.Err(); err != nil {
			return count, err
		}
		if err = entry.deletePinned(force); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (tree *CapturedTree) Close() {
	if tree == nil {
		return
	}
	for i := len(tree.held) - 1; i >= 0; i-- {
		tree.held[i].Close()
	}
	tree.held = nil
	tree.order = nil
	tree.consumed = true
}
