import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import type { Health, Settings } from '../api';
import type { Evidence } from '../records/core';
import { Button, Field, Header, Notice, styles } from './base';
import { AnswerSources, evidenceRefs, type Jump, RichText } from './Library';

export function SettingsPage({settings, back, connect, setAudioPreference, exportAll, status, result, working}: {
  settings: Settings; back: () => void; connect: (address: string, token: string, keepAudio: boolean) => void;
  setAudioPreference: (keepAudio: boolean) => void;
  exportAll: () => void; status?: string; result?: Health; working: boolean;
}) {
  const [url, setUrl] = useState(settings.url || '');
  const [token, setToken] = useState(settings.token || '');
  return <>
    <Header title="설정" sub="이 기기의 연결과 저장" onBack={back}/>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.heading}>서버 연결</Text>
        <Text style={styles.small}>개인 서버 주소와 접근 토큰을 한 번 입력합니다. 서비스 API 키는 서버에만 보관합니다.</Text>
        <Field label="서버 주소" placeholder="https://sitenote.example" value={url} onChangeText={setUrl}
          keyboardType="url" autoCapitalize="none" autoCorrect={false}/>
        <Field label="서버 접근 토큰" value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false}/>
        <View style={styles.row}><Button label={working ? '확인 중…' : '연결 확인 및 저장'} variant="primary"
          disabled={working} onPress={() => connect(url, token, !!settings.keepAudio)}/></View>
        {result && <Text style={styles.small}>서버 응답 확인 · GPT-Live {result.providers.live ? '키 설정됨' : '키 없음'} · Soniox {result.providers.soniox ? '키 설정됨' : '키 없음'} · 요약/검색 {result.providers.text ? '키 설정됨' : '키 없음'}</Text>}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>저장 및 내보내기</Text>
        <Text style={styles.small}>확정 전사와 요약은 항상 이 기기에 Markdown으로 저장합니다.</Text>
        <View style={styles.between}>
          <Text style={[styles.body, {flexShrink: 1}]}>마이크 음성 사본도 보관</Text>
          <Switch accessibilityLabel="마이크 음성 사본도 보관" value={!!settings.keepAudio} disabled={working} onValueChange={setAudioPreference}/>
        </View>
        <Text style={styles.small}>새로 시작하는 녹음에 적용됩니다. AI가 재생되는 구간은 음성 사본에서 음소거됩니다.</Text>
        <View style={styles.row}><Button label="전체 Markdown 내보내기" onPress={exportAll}/></View>
      </View>
      {status && <Notice text={status}/>}
      <Notice text="개인 대화와 회의의 전사는 Soniox가 처리합니다. AI 음성 질문을 켜거나 보완 대화를 시작한 경우에는 OpenAI가 음성 답변을 처리하며, 요약에는 관련 텍스트를 사용합니다."/>
    </ScrollView>
  </>;
}

export type SearchResult = {answer: string; evidence: Evidence[]; cited: ReadonlySet<string>; question: string};
export function SearchPage({back, jump, run, result, status, working}: {
  back: () => void; jump: Jump; run: (question: string) => void; result?: SearchResult; status?: string; working: boolean;
}) {
  const [question, setQuestion] = useState(result?.question || '');
  return <>
    <Header title="기록 검색" sub="내 기록에 물어보기" onBack={back}/>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="질문" placeholder="지난 회의에서 일정을 왜 바꿨지?" value={question} onChangeText={setQuestion}
        maxLength={2000} multiline style={{minHeight: 72}}/>
      <View style={styles.row}>
        <Button label={working ? '찾는 중…' : '기록에서 답 찾기'} variant="primary" disabled={working || !question.trim()}
          onPress={() => run(question.trim())}/>
      </View>
      {status && <Notice text={status}/>}
      {result && <>
        <View style={styles.card}>
          <Text style={styles.label}>{result.question}</Text>
          <RichText value={result.answer} refs={evidenceRefs(result.evidence.filter(item => result.cited.has(item.reference)), jump)}/>
        </View>
        <AnswerSources items={result.evidence} quoted={result.cited} jump={jump}/>
      </>}
    </ScrollView>
  </>;
}
