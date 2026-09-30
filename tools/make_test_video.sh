#!/usr/bin/env bash
# Generate Syntheniq's test source video: a 3-topic creator monologue with
# deliberate dead air, fillers and an emotional peak, over a 1080p testsrc2
# background (16:9 source to exercise the 9:16 reframe).
set -e
cd "$(dirname "$0")"
mkdir -p tts models
[ -f models/en_US-lessac-medium.onnx ] || python3 -m piper.download_voices en_US-lessac-medium && cp /tmp/en_US-lessac-medium.onnx* models/ 2>/dev/null || true

say() { # $1=file  $2=text
  echo "$2" | python3 -m piper --model models/en_US-lessac-medium.onnx --output_file "tts/$1.wav" 2>/dev/null
}

say t1 "So three months ago, I made a huge mistake with my editing workflow. I spent six hours on a single short. And it got forty views. Um, forty. That is the moment I decided to completely fix my process."
say t2 "The first thing that changed everything, is that I stopped starting my videos with an intro. No more hey guys, welcome back. I just start mid sentence, with the most interesting part. It sounds simple, but it more than doubled my watch time."
say t3 "The second thing is captions. If a viewer cannot read your screen, they cannot follow you. Big text, two or three words at a time, and highlight the important words. People watch with the sound off, all the time."
say t4 "If you fix just those two things, your retention will change completely. Try it for one week, and come back and thank me."

# concat with dead-air gaps (silence generated via aevalsrc)
ffmpeg -y -v error \
  -i tts/t1.wav -f lavfi -t 1.8 -i "aevalsrc=0:s=44100" \
  -i tts/t2.wav -f lavfi -t 1.4 -i "aevalsrc=0:s=44100" \
  -i tts/t3.wav -f lavfi -t 1.8 -i "aevalsrc=0:s=44100" \
  -i tts/t4.wav \
  -filter_complex "[0]aresample=22050[a0];[1]aresample=22050[a1];[2]aresample=22050[a2];[3]aresample=22050[a3];[4]aresample=22050[a4];[5]aresample=22050[a5];[6]aresample=22050[a6];[a0][a1][a2][a3][a4][a5][a6]concat=n=7:v=0:a=1[out]" \
  -map "[out]" -c:a pcm_s16le audio_full.wav

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1 audio_full.wav | cut -d. -f1)
echo "audio: ${DUR}s"

ffmpeg -y -v error -f lavfi -i "testsrc2=size=1920x1080:rate=30" -i audio_full.wav \
  -t "$DUR" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -shortest syntheniq-test-source.mp4

ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate -of default=nw=1 syntheniq-test-source.mp4
echo "OK: syntheniq-test-source.mp4"
