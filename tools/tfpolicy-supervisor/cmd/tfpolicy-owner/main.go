package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"terrence.tools/tfpolicy-supervisor/internal/execution"
)

func main() {
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
		if json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "contractVersion": 2}) != nil {
			os.Exit(1)
		}
		return
	}
	result, err := execution.Execute(ctx, c)
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
