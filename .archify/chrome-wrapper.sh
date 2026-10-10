#!/bin/sh
exec /usr/bin/google-chrome --disable-dev-shm-usage --disable-crash-reporter --disable-breakpad "$@"
