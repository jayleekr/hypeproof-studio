#!/bin/zsh
cd "$(dirname "$0")/.." || exit 1
python3 scripts/studio-dev.py run
result=$?
if [[ $result != 0 ]]; then
  read '?위 오류를 확인하고 Enter를 누르세요. '
fi
exit $result
