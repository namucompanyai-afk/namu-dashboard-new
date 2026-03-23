"use client";

import { useRouter } from "next/navigation";
import styles from "../(auth)/auth.module.css";

export default function SignupPage() {
  const router = useRouter();

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>회원가입</h1>
        <p className={styles.subTitle}>내부 대시보드 전용 계정을 생성합니다.</p>

        <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
          <label className={styles.label}>이름</label>
          <input className={styles.input} type="text" placeholder="홍길동" />

          <label className={styles.label}>이메일</label>
          <input className={styles.input} type="email" placeholder="name@company.com" />

          <label className={styles.label}>비밀번호</label>
          <input className={styles.input} type="password" placeholder="8자 이상" />

          <label className={styles.label}>비밀번호 확인</label>
          <input className={styles.input} type="password" placeholder="동일하게 한 번 더" />

          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => router.push("/login")}
          >
            회원가입
          </button>
        </form>

        <div className={styles.bottomText}>
          이미 계정이 있으신가요?{" "}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => router.push("/login")}
          >
            로그인
          </button>
        </div>
      </div>
    </div>
  );
}
