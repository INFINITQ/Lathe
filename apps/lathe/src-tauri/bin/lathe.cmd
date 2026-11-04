@echo off
rem `lathe` in a terminal: `lathe .`, `lathe file.py:12`, and `lathe --wait file`, which returns
rem when you close the file (so Git can use Lathe as its editor). Installed in Lathe's bin folder.
"%~dp0..\lathe.exe" --cli %*
