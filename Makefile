BUN ?= bun
BIN := zeroproxy

.PHONY: build demo test typecheck proof reproduce bench clean all

all: build

build:
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)

demo:
	$(BUN) demo/run.ts

test:
	$(BUN) test

typecheck:
	$(BUN)x tsc --noEmit

bench:
	$(BUN) run bench/bench.ts

proof:
	$(BUN) pm ls > deps-proof.txt

# Build twice to the SAME outfile name (the filename is embedded in the binary,
# so different names would differ by one byte). Copy apart afterwards.
reproduce:
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)-repro && cp $(BIN)-repro $(BIN)-build-1
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)-repro && cp $(BIN)-repro $(BIN)-build-2
	rm -f $(BIN)-repro
	sha256sum $(BIN)-build-1 $(BIN)-build-2 > BUILD_HASHES.txt
	cmp $(BIN)-build-1 $(BIN)-build-2 && echo "BYTE-IDENTICAL"

clean:
	rm -f $(BIN) $(BIN)-build-1 $(BIN)-build-2 $(BIN)-repro BUILD_HASHES.txt
