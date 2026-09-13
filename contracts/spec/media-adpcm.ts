/** Independent stereo IMA blocks: two (i16 predictor, u8 index, u8 zero)
 * headers, then one byte per remaining frame (left low nibble, right high).
 * Each block can recover after seeking without state from an older stream. */
export const IMA_STEPS=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767] as const;
const INDEX=[-1,-1,-1,-1,2,4,6,8];
export function encodeMediaAudio(pcm:Uint8Array,indices:[number,number]=[0,0]):Uint8Array {
  if(!pcm.length || pcm.length%4 || pcm.length>4096) throw new Error("Invalid stereo PCM block");
  const frames=pcm.length/4,view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
  const out=new Uint8Array(frames+7),header=new DataView(out.buffer);
  const predictor=[view.getInt16(0,true),view.getInt16(2,true)];
  for(let channel=0;channel<2;channel++) {header.setInt16(channel*4,predictor[channel],true);out[channel*4+2]=indices[channel];}
  for(let frame=1;frame<frames;frame++) for(let channel=0;channel<2;channel++) {
    const step=IMA_STEPS[indices[channel]];
    let delta=view.getInt16(frame*4+channel*2,true)-predictor[channel],code=delta<0?8:0;
    delta=Math.abs(delta);let difference=step>>3;
    for(let bit=4,threshold=step;bit;bit>>=1,threshold>>=1) if(delta>=threshold) {code|=bit;delta-=threshold;difference+=threshold;}
    predictor[channel]=Math.max(-32768,Math.min(32767,predictor[channel]+(code&8?-difference:difference)));
    indices[channel]=Math.max(0,Math.min(88,indices[channel]+INDEX[code&7]));
    out[frame+7]|=code<<(channel*4);
  }
  return out;
}
