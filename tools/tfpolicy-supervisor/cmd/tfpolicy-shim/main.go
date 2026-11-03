package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"terrence.tools/tfpolicy-supervisor/internal/bootstrap"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if e := bootstrap.RunShim(ctx, os.Getenv("TFPOLICY_SUPERVISOR_SOCKET"), os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, "tfpolicy bootstrap failed:", e)
		os.Exit(1)
	}
}
