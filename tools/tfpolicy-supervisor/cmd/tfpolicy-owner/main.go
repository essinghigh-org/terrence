package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"terrence.tools/tfpolicy-supervisor/internal/execution"
	"time"
)

func main() {
	parentPID := os.Getppid()
	if len(os.Args) != 4 || (os.Args[1] != "execute" && os.Args[1] != "probe") || os.Args[2] != "--config" {
		fmt.Fprintln(os.Stderr, "usage: tfpolicy-owner execute|probe --config /private/run.json")
		os.Exit(2)
	}
	c, err := execution.LoadConfig(os.Args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if os.Args[1] == "probe" {
		if err := execution.Probe(ctx, c); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "contractVersion": 2, "receiptVersion": 2, "runtimeSha256": execution.RuntimeIdentitySHA256(c.Runtime)}) != nil {
			os.Exit(1)
		}
		return
	}
	// The host can disappear without running its cancellation/finally path.
	// Observe parenthood rather than a numeric PID's continued existence: a
	// dead parent can be replaced by an unrelated process with the same PID.
	if (c.ParentPID != 0 && c.ParentPID != parentPID) || os.Getppid() != parentPID {
		fmt.Fprintln(os.Stderr, "native owner lost its expected execution parent")
		os.Exit(1)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if os.Getppid() != parentPID {
					cancel()
					return
				}
			}
		}
	}()
	result, err := execution.Execute(ctx, c)
	if os.Getppid() != parentPID && result.CgroupEmpty && filepath.Dir(result.Directory) == c.PrivateParent {
		// With no live recipient, these private captures have no retention
		// owner. Managed state is in the separate execution directory.
		_ = os.RemoveAll(result.Directory)
	}
	if e := json.NewEncoder(os.Stdout).Encode(result); e != nil {
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if !result.Verified || !result.Evidence.Allows {
		os.Exit(1)
	}
}
