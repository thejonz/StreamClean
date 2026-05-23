#!/usr/bin/env python3
"""Start the StreamClean dev server."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("server.main:app", host="127.0.0.1", port=8765, reload=True)
