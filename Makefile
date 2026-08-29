BUN ?= bun
BIN := zeroproxy

.PHONY: build test proof reproduce clean all

all: build

build:
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)

test:
	$(BUN) test

typecheck:
	$(BUN)x tsc --noEmit

proof:
	$(BUN) pm ls > deps-proof.txt

reproduce:
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)-build-1
	$(BUN) build ./src/index.ts --compile --outfile $(BIN)-build-2
	sha256sum $(BIN)-build-1 $(BIN)-build-2 > BUILD_HASHES.txt
	cmp $(BIN)-build-1 $(BIN)-build-2 && echo "BYTE-IDENTICAL"

clean:
	rm -f $(BIN) $(BIN)-build-1 $(BIN)-build-2 BUILD_HASHES.txt
