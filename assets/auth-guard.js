// Firebase Auth guard for protected pages
// - Ensures user is signed in (session persists until browser is closed)
// - Redirects to login when unauthenticated
// - Exposes window.firebaseAuth, window.currentUser, window.signOutCurrent
// - Adds a Logout button and user label to the topbar actions

// Load Firebase (v10 modular) from CDN
import { getFirebaseApp } from './firebase-config.js';
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore, collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-lite.js';

const app = getFirebaseApp();
const auth = getAuth(app);
const db = getFirestore(app);

// Persist within the browser session (cleared when the tab/browser closes)
try { await setPersistence(auth, browserSessionPersistence); } catch (_) {}

// users 컬렉션에서 email로 name을 조회하는 함수
async function getUserNameByEmail(email) {
  if (!email) return email || '';
  
  try {
    const usersCol = collection(db, 'users');
    const snapshot = await getDocs(usersCol);
    const normalizedEmail = email.toLowerCase().trim();
    
    for (const docSnap of snapshot.docs) {
      const userData = docSnap.data();
      
      // userData가 배열인 경우
      if (Array.isArray(userData)) {
        for (const item of userData) {
          if (item && typeof item === 'object' && item.mail) {
            const normalizedMail = String(item.mail || '').toLowerCase().trim();
            if (normalizedMail === normalizedEmail && item.name) {
              return item.name;
            }
          }
        }
      }
      // userData가 객체이고 users 배열을 가진 경우
      else if (userData && typeof userData === 'object' && Array.isArray(userData.users)) {
        for (const item of userData.users) {
          if (item && typeof item === 'object' && item.mail) {
            const normalizedMail = String(item.mail || '').toLowerCase().trim();
            if (normalizedMail === normalizedEmail && item.name) {
              return item.name;
            }
          }
        }
      }
      // userData가 직접 mail과 name 필드를 가진 경우
      else if (userData && typeof userData === 'object' && userData.mail) {
        const normalizedMail = String(userData.mail || '').toLowerCase().trim();
        if (normalizedMail === normalizedEmail && userData.name) {
          return userData.name;
        }
      }
    }
  } catch (error) {
    // 권한 오류 등은 조용히 처리하고 email 반환
    console.debug('[Auth Guard] users 컬렉션 조회 실패:', error);
  }
  
  // 찾지 못하면 email 반환
  return email;
}

function updateTopbarForUser(user) {
  async function ensureLogoutUI() {
    const actions = document.querySelector('.topbar .actions');
    if (!actions) return;
    
    // 버튼 순서: 이름 -> 로그아웃 -> 설비목록
    
    // 1. 사용자 이름 라벨 추가/업데이트 (가장 앞에)
    let userLabel = document.getElementById('authUserLabel');
    if (!userLabel) {
      userLabel = document.createElement('span');
      userLabel.id = 'authUserLabel';
      userLabel.style.marginRight = '20px';
      userLabel.style.fontSize = '14px';
      userLabel.style.fontWeight = '500';
      userLabel.style.color = '#4b5563';
      userLabel.style.letterSpacing = '0.01em';
      userLabel.style.fontFamily = '"Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      // 이름 라벨을 가장 앞에 배치
      actions.insertBefore(userLabel, actions.firstChild);
    }
    
    // users 컬렉션에서 name 조회
    const userEmail = user?.email || '';
    if (userEmail) {
      getUserNameByEmail(userEmail).then(name => {
        if (userLabel) {
          const displayName = name && name !== userEmail ? `${name}님 로그인됨` : `${userEmail}`;
          userLabel.textContent = displayName;
        }
      }).catch(() => {
        // 오류 시 email로 표시
        if (userLabel) {
          userLabel.textContent = `${userEmail}`;
        }
      });
    } else {
      userLabel.textContent = user?.displayName || '';
    }

    // 2. 로그아웃 버튼 처리 (이메일 다음에)
    const toggleBtn = document.getElementById('btnToggleEdit');
    let logoutBtn = null;
    
    if (toggleBtn) {
      toggleBtn.textContent = '로그아웃';
      toggleBtn.onclick = async () => { try { await signOut(auth); } catch(_) {} };
      // 로그아웃 버튼 스타일: 흰색 배경 + 검정 폰트
      toggleBtn.style.background = '#ffffff';
      toggleBtn.style.color = '#000000';
      toggleBtn.style.border = '1px solid #e5e7eb';
      // 버튼 순서 조정: 이메일 다음에 배치
      if (userLabel.nextSibling !== toggleBtn) {
        toggleBtn.remove();
        userLabel.insertAdjacentElement('afterend', toggleBtn);
      }
      logoutBtn = toggleBtn;
    } else {
      // Otherwise add a dedicated Logout button once
      let btn = document.getElementById('btnLogout');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'btnLogout';
        btn.type = 'button';
        btn.textContent = '로그아웃';
        // 로그아웃 버튼 스타일: 흰색 배경 + 검정 폰트
        btn.style.background = '#ffffff';
        btn.style.color = '#000000';
        btn.style.border = '1px solid #e5e7eb';
        btn.addEventListener('click', async () => { try { await signOut(auth); } catch (_) {} });
        // 이메일 다음에 배치
        userLabel.insertAdjacentElement('afterend', btn);
      }
      logoutBtn = btn;
    }
    
    // 3. 설비목록 버튼을 로그아웃 다음에 배치
    const btnList = document.getElementById('btnList');
    if (btnList && logoutBtn) {
      if (logoutBtn.nextSibling !== btnList) {
        btnList.remove();
        logoutBtn.insertAdjacentElement('afterend', btnList);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureLogoutUI());
  } else {
    ensureLogoutUI();
  }
}

onAuthStateChanged(auth, (user) => {
  // Expose for app scripts
  window.firebaseAuth = auth;
  window.currentUser = user || null;
  try { window.dispatchEvent(new CustomEvent('auth-state-changed', { detail: { user } })); } catch (_) {}

  if (!user) {
    const redirectTo = encodeURIComponent(location.pathname + location.search);
    // Avoid redirect loops if already on login
    if (!/index\.html$/i.test(location.pathname)) {
      location.replace(`index.html?redirect=${redirectTo}`);
    }
    return;
  }

  updateTopbarForUser(user);
});

// Export a convenience logout function for non-module scripts
window.signOutCurrent = async function signOutCurrent() {
  try { await signOut(auth); } catch (_) {}
};
