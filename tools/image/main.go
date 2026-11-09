// Command image packages a linux-x64 pi-janus binary as an OCI image tarball.
//
// Built without Docker, a daemon, a VM or the crane CLI: the pinned distroless
// base plus one layer holding /pi-janus, with the entrypoint, env, user and
// port set.
// Publishing (registry, tags, deploy) belongs to the infrastructure repository:
// `crane push <tarball> <registry>/<repo>:<tag>`.
//
// Usage (from anywhere in the repo):
//
//	go -C tools/image run .                              # dist/linux-x64/pi-janus -> dist/image/pi-janus-linux-amd64.tar
//	go -C tools/image run . -binary PATH -out FILE
package main

import (
	"archive/tar"
	"bytes"
	"debug/elf"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/google/go-containerregistry/pkg/v1/validate"
)

// gcr.io/distroless/base-debian13:nonroot, linux/amd64 manifest, pinned 2026-11-09.
// Refresh: crane manifest gcr.io/distroless/base-debian13:nonroot | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
const baseImage = "gcr.io/distroless/base-debian13@sha256:8c58c4fa7af56e7e1e5f0f517fab503a0b59c764cd2d25906d6e995bae5546f2"

// Name recorded inside the tarball only; the push sets the real reference.
const imageName = "janus-inference-control-plane:local"

const (
	binaryName = "pi-janus"
	entrypoint = "/" + binaryName
	envHost    = "JANUS_HOST=0.0.0.0"
	user       = "nonroot"
	port       = "8787/tcp"
)

func main() {
	binary := flag.String("binary", "", "linux-x64 pi-janus binary (default <repo>/dist/linux-x64/pi-janus)")
	out := flag.String("out", "", "output image tarball (default <repo>/dist/image/pi-janus-linux-amd64.tar)")
	flag.Parse()
	if err := run(*binary, *out); err != nil {
		fmt.Fprintln(os.Stderr, "image:", err)
		os.Exit(1)
	}
}

func run(binary, out string) error {
	if binary == "" || out == "" {
		root, err := repoRoot()
		if err != nil {
			return err
		}
		if binary == "" {
			binary = filepath.Join(root, "dist", "linux-x64", binaryName)
		}
		if out == "" {
			out = filepath.Join(root, "dist", "image", "pi-janus-linux-amd64.tar")
		}
	}

	if err := checkLinuxX64(binary); err != nil {
		return err
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		return err
	}
	layerTar, err := oneFileTar(binaryName, data)
	if err != nil {
		return err
	}
	layer, err := tarball.LayerFromOpener(func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(layerTar)), nil
	})
	if err != nil {
		return err
	}

	baseRef, err := name.ParseReference(baseImage)
	if err != nil {
		return err
	}
	base, err := remote.Image(baseRef)
	if err != nil {
		return fmt.Errorf("fetch base %s: %w", baseImage, err)
	}
	img, err := mutate.AppendLayers(base, layer)
	if err != nil {
		return err
	}
	cfg, err := img.ConfigFile()
	if err != nil {
		return err
	}
	cfg = cfg.DeepCopy()
	cfg.Config.Entrypoint = []string{entrypoint}
	cfg.Config.Env = append(cfg.Config.Env, envHost)
	cfg.Config.User = user
	cfg.Config.ExposedPorts = map[string]struct{}{port: {}}
	img, err = mutate.ConfigFile(img, cfg)
	if err != nil {
		return err
	}

	tag, err := name.NewTag(imageName)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	if err := tarball.WriteToFile(out, tag, img); err != nil {
		return err
	}

	// Check the file that will be pushed, not the in-memory image.
	written, err := tarball.ImageFromPath(out, &tag)
	if err != nil {
		return err
	}
	if err := validate.Image(written); err != nil {
		return fmt.Errorf("%s is not a valid image: %w", out, err)
	}
	if err := checkConfig(written); err != nil {
		return err
	}
	return report(out, written)
}

// repoRoot walks up from the working directory to the folder holding bun.lock.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "bun.lock")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("repo root (bun.lock) not found; pass -binary and -out")
		}
		dir = parent
	}
}

func checkLinuxX64(path string) error {
	f, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("%s: not an ELF binary (build: scripts/release.sh --skip-tests linux-x64): %w", path, err)
	}
	defer f.Close()
	if f.Class != elf.ELFCLASS64 || f.Machine != elf.EM_X86_64 || (f.OSABI != elf.ELFOSABI_NONE && f.OSABI != elf.ELFOSABI_LINUX) {
		return fmt.Errorf("%s: expected a linux x86-64 ELF, got %s %s %s", path, f.Class, f.Machine, f.OSABI)
	}
	return nil
}

// oneFileTar returns an uncompressed tar holding one executable owned by root.
// The fixed mtime makes the layer digest depend only on the binary.
func oneFileTar(name string, data []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	hdr := &tar.Header{
		Typeflag: tar.TypeReg,
		Name:     name,
		Mode:     0o755,
		Size:     int64(len(data)),
		Uname:    "root",
		Gname:    "root",
		ModTime:  time.Unix(0, 0),
		Format:   tar.FormatPAX,
	}
	if err := w.WriteHeader(hdr); err != nil {
		return nil, err
	}
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func checkConfig(img v1.Image) error {
	cfg, err := img.ConfigFile()
	if err != nil {
		return err
	}
	c := cfg.Config
	_, hasPort := c.ExposedPorts[port]
	if cfg.OS != "linux" || cfg.Architecture != "amd64" ||
		!slices.Equal(c.Entrypoint, []string{entrypoint}) || c.User != user ||
		!slices.Contains(c.Env, envHost) || !hasPort {
		return fmt.Errorf("unexpected image config: %s/%s entrypoint=%v user=%q env=%v ports=%v",
			cfg.OS, cfg.Architecture, c.Entrypoint, c.User, c.Env, c.ExposedPorts)
	}
	return nil
}

func report(out string, img v1.Image) error {
	id, err := img.ConfigName()
	if err != nil {
		return err
	}
	layers, err := img.Layers()
	if err != nil {
		return err
	}
	top, err := layers[len(layers)-1].Digest()
	if err != nil {
		return err
	}
	info, err := os.Stat(out)
	if err != nil {
		return err
	}
	fmt.Printf("==> image: %s (%d MB)\n", out, info.Size()>>20)
	fmt.Printf("    base:      %s\n", baseImage)
	fmt.Printf("    image id:  %s\n", id)
	fmt.Printf("    pi-janus layer: %s\n", top)
	return nil
}
